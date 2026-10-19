/*
 * Original code for bluray-web: the engine side of a BD-J worker. It boots the worker, answers Java's calls through
 * PlayerBdjHost, passes title starts and BD-J events in, and stops the worker on any failure (spec §5).
 *
 * Copyright (C) 2026  bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { DiscSpec } from '../disc/disc-spec';
import type { ScreenRect } from './background';
import type { PlayerBdjHost } from './player-host';
import type { Coalesce } from './input';
import type { BdjMemoryBudgets, ClassLibrarySource } from './runtime';
import type { StatusBlockWriter } from './status-block';
import { bootTransfer, type BdjCallName, type BdjFailureCode, type BdjWireValue, type FromBdj, type ToBdj } from './worker-protocol';

export type { BdjFailureCode } from './worker-protocol';

export interface WorkerLike {
  /** `transfer`: a boot message's fetch port (bootTransfer). */
  postMessage(message: ToBdj, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<FromBdj>) => void) | null;
  onerror?: ((event: ErrorEvent) => void) | null;
  terminate(): void;
}

export interface BdjSessionDeps {
  readonly worker: WorkerLike;
  readonly host: Pick<PlayerBdjHost, 'handle'>;
  /** The register file's shared buffer (RegisterFile({ shared })). */
  readonly regs: SharedArrayBuffer;
  readonly status: StatusBlockWriter;
  /** The graphics plane's shared buffer (createGraphicsPlane). */
  readonly plane: SharedArrayBuffer;
  /** bd_tell_time's position in 45 kHz ticks, published before selectPlaylist and seek reply. */
  readonly time45: () => bigint;
  readonly onFailed: (code: BdjFailureCode, message: string) => void;
  readonly onLog?: (line: string, error: boolean) => void;
  /** A background still Java asked to show (null: none). */
  readonly onBackground?: (image: Uint8Array | null, rect: ScreenRect) => void;
  /** The worker's NAS reads got a 401: a fresh token is wanted (setToken delivers it). */
  readonly onTokenNeeded?: () => void;
  readonly nowMs: () => number;
  readonly setTimer: (ms: number, fn: () => void) => () => void;
  /** How long after boot (or the first start) Java has to select a playlist, show a menu or show a background still. */
  readonly selectTimeoutMs?: number;
  /** The memory profile's BD-J budgets, for the boot message. */
  readonly memory?: BdjMemoryBudgets;
  /** Asks the worker for its memory stats every this many ms (telemetry), which arrive here. */
  readonly memoryStatsMs?: number;
  readonly onMemory?: (stats: Extract<FromBdj, { type: 'memory' }>) => void;
}

/**
 * The start-up timeout: a BD-J title that has neither selected a playlist nor shown anything (a visible plane, a
 * background still) this long after boot is taken as hung, and the player falls back to the picker. A menu that waits
 * for input over a still or an empty video plane is alive (ruling R7).
 */
export const SELECT_PLAYLIST_TIMEOUT_MS = 20_000;

/** At the start-up timeout, how long the worker has to log its thread dump before it is stopped. */
export const DUMP_WAIT_MS = 1_000;

export class BdjSession {
  private stopped = false;
  private bootDone: (() => void) | null = null;
  private startedAt: number | null = null;
  private cancelTimeout: (() => void) | null = null;
  /** The call whose synchronous handling is under way. */
  private callInHand: number | null = null;
  /** Starts (and what follows them) wait for the reply to this call. */
  private holdFor: number | null = null;
  private readonly held: ToBdj[] = [];
  private activityCount = 0;
  /** Calls the engine is answering (diagnostics). */
  private readonly answering = new Map<number, BdjCallName>();
  /** The start-up timeout has fired: the session fails once the worker's thread dump is in (or DUMP_WAIT_MS on). */
  private timedOut: (() => void) | null = null;

  constructor(private readonly deps: BdjSessionDeps) {
    deps.worker.onmessage = (e) => this.receive(e.data);
    deps.worker.onerror = (e) => this.fail('internal', `the BD-J worker failed: ${e.message}`);
  }

  /** Settles once the worker has booted, or once the session has ended. */
  boot(disc: DiscSpec, readAheadBytes: number, discId: string | null, classLibrary: ClassLibrarySource): Promise<void> {
    return new Promise((resolve) => {
      if (this.stopped) return resolve();
      this.armTimeout();
      this.bootDone = resolve;
      const { memory, memoryStatsMs } = this.deps;
      this.post({
        type: 'boot',
        registers: this.deps.regs,
        status: this.deps.status.buffer,
        plane: this.deps.plane,
        disc,
        readAheadBytes,
        discId,
        classLibrary,
        ...(memory ? { memory } : {}),
        ...(memoryStatsMs ? { memoryStatsMs } : {}),
      });
    });
  }

  /** A fresh session token for the worker's NAS reads. */
  setToken(token: string): void {
    if (!this.stopped) this.post({ type: 'remoteToken', token });
  }

  start(title: number): void {
    if (this.stopped) return;
    this.armTimeout();
    if (this.holdFor === null && this.callInHand !== null) this.holdFor = this.callInHand;
    this.send({ type: 'start', title });
  }

  /** The first-playlist timeout runs from boot (or the first start, without a boot), so a hung boot falls back too. */
  private armTimeout(): void {
    if (this.startedAt !== null) return;
    this.startedAt = this.deps.nowMs();
    const ms = this.deps.selectTimeoutMs ?? SELECT_PLAYLIST_TIMEOUT_MS;
    this.cancelTimeout = this.deps.setTimer(ms, () => this.timeout(`no playlist was selected and nothing was shown within ${ms / 1000} s`));
  }

  /** The start-up timeout: the engine's side and the worker's thread dump go to the log, then the session fails. */
  private timeout(message: string): void {
    if (this.stopped) return;
    this.cancelTimeout = null;
    const calls = [...this.answering].map(([id, name]) => `${name}#${id}`);
    this.deps.onLog?.(
      `BD-J start-up timeout: ${this.bootDone ? 'not booted' : 'booted'}, ${calls.length ? `the engine is answering ${calls.join(', ')}` : 'no call in the engine'}, ` +
        `${this.held.length} messages held${this.holdFor !== null ? ` for the reply to #${this.holdFor}` : ''}`,
      true,
    );
    const cancel = this.deps.setTimer(DUMP_WAIT_MS, () => {
      if (this.stopped) return;
      this.deps.onLog?.(`BD-J worker sent no thread dump within ${DUMP_WAIT_MS} ms (its event loop is blocked)`, true);
      this.timedOut?.();
    });
    this.timedOut = () => {
      cancel();
      this.timedOut = null;
      this.fail('timeout', message);
    };
    this.post({ type: 'dump', reason: 'start-up timeout' });
  }

  event(ev: number, param: number, coalesce?: Coalesce): void {
    if (!this.stopped) this.send({ type: 'event', ev, param, ...(coalesce ? { coalesce } : {}) });
  }

  /**
   * Counts what Java sent that shows it acted: every call (playback control, register writes, titles, sounds...) and
   * every background still. Only its changes matter (the ignored-tap rule, input.ts).
   */
  get activity(): number {
    return this.activityCount;
  }

  /** Terminates the worker; nothing it sent afterwards is acted on. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelTimeout?.();
    this.cancelTimeout = null;
    this.deps.worker.onmessage = null;
    this.deps.worker.onerror = null;
    this.deps.worker.terminate();
    this.bootDone?.();
    this.bootDone = null;
  }

  private receive(m: FromBdj): void {
    if (this.stopped) return;
    // after the start-up timeout only the dump is waited for: Java is refused as after stop() (nothing it sends is
    // acted on), so a playlist it selects now does not play behind the fallback
    if (this.timedOut && m.type !== 'log' && m.type !== 'dumped') return;
    switch (m.type) {
      case 'booted':
        this.deps.onLog?.(`BD-J booted in ${Math.round(m.bootMs)} ms`, false);
        this.bootDone?.();
        this.bootDone = null;
        break;
      case 'call':
        this.activityCount++;
        void this.answer(m.id, m.name, m.args);
        break;
      case 'log':
        this.deps.onLog?.(m.line, m.error);
        break;
      case 'background':
        this.activityCount++;
        if (m.image) this.alive('showed a background still');
        this.deps.onBackground?.(m.image, m.rect);
        break;
      case 'failed':
        this.fail(m.code, m.message);
        break;
      case 'memory':
        this.deps.onMemory?.(m);
        break;
      case 'remoteTokenNeeded':
        this.deps.onTokenNeeded?.();
        break;
      case 'dumped':
        this.timedOut?.();
        break;
    }
  }

  private async answer(id: number, name: BdjCallName, args: readonly BdjWireValue[]): Promise<void> {
    if (name === 'selectPlaylist' && Number(args[0]) >= 0) this.alive('selected its first playlist');
    let pending: Promise<number | string>;
    this.answering.set(id, name);
    this.callInHand = id;
    try {
      pending = this.deps.host.handle(name, args);
    } finally {
      this.callInHand = null;
    }
    // a call whose own handling stopped the session (selectTitle of an HDMV title: _play_hdmv → _stop_bdj) still has
    // its answer, as libbluray's native returns to Java; the reply goes to a terminated worker, where it is dropped
    const stoppedByThisCall = this.stopped;
    let value: number | string;
    try {
      value = await pending;
    } catch (e) {
      this.fail('internal', `${name} failed in the player: ${e instanceof Error ? e.message : String(e)}`);
      return;
    } finally {
      this.answering.delete(id);
    }
    if (stoppedByThisCall) {
      this.post({ type: 'reply', id, value });
      return;
    }
    if (this.stopped) return;
    if (name === 'selectPlaylist' || name === 'seek') this.deps.status.setTime45(this.deps.time45());
    this.post({ type: 'reply', id, value });
    if (this.holdFor === id) {
      this.holdFor = null;
      for (const m of this.held.splice(0)) this.post(m);
    }
  }

  /** The graphics plane turned visible: a menu on screen keeps the title alive without a playlist (ruling R7). */
  menuShown(): void {
    if (!this.stopped) this.alive('showed a menu');
  }

  /** Java showed it runs: the start-up timeout is cancelled, once. */
  private alive(what: string): void {
    if (this.startedAt === null || this.cancelTimeout === null) return;
    this.cancelTimeout();
    this.cancelTimeout = null;
    this.deps.onLog?.(`BD-J ${what} ${Math.round(this.deps.nowMs() - this.startedAt)} ms after boot`, false);
  }

  private send(m: ToBdj): void {
    if (this.holdFor !== null) this.held.push(m);
    else this.post(m);
  }

  private post(m: ToBdj): void {
    this.deps.worker.postMessage(m, bootTransfer(m));
  }

  private fail(code: BdjFailureCode, message: string): void {
    if (this.stopped) return;
    this.stop();
    this.deps.onFailed(code, message);
  }
}
