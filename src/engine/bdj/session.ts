/*
 * Original code for bluray-web: the engine side of a BD-J worker. It boots the worker, answers Java's calls through
 * PlayerBdjHost, passes title starts and BD-J events in, and stops the worker on any failure (spec §5).
 *
 * Copyright (C) 2026  bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { PlayerBdjHost } from './player-host';
import type { ClassLibrarySource } from './runtime';
import type { StatusBlockWriter } from './status-block';
import type { BdjCallName, BdjFailureCode, BdjWireValue, FromBdj, ToBdj } from './worker-protocol';

export type { BdjFailureCode } from './worker-protocol';

export interface WorkerLike {
  postMessage(message: ToBdj): void;
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
  /** bd_tell_time's position in 45 kHz ticks, published before selectPlaylist and seek reply. */
  readonly time45: () => bigint;
  readonly onFailed: (code: BdjFailureCode, message: string) => void;
  readonly onLog?: (line: string, error: boolean) => void;
  readonly nowMs: () => number;
  readonly setTimer: (ms: number, fn: () => void) => () => void;
  /** How long after boot (or the first start) Java has to select a playlist. */
  readonly selectTimeoutMs?: number;
}

export const SELECT_PLAYLIST_TIMEOUT_MS = 20_000;

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

  constructor(private readonly deps: BdjSessionDeps) {
    deps.worker.onmessage = (e) => this.receive(e.data);
    deps.worker.onerror = (e) => this.fail('internal', `the BD-J worker failed: ${e.message}`);
  }

  /** Settles once the worker has booted, or once the session has ended. */
  boot(files: readonly (readonly [string, Blob])[], discId: string | null, classLibrary: ClassLibrarySource): Promise<void> {
    return new Promise((resolve) => {
      if (this.stopped) return resolve();
      this.armTimeout();
      this.bootDone = resolve;
      this.post({ type: 'boot', registers: this.deps.regs, status: this.deps.status.buffer, discFiles: files, discId, classLibrary });
    });
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
    this.cancelTimeout = this.deps.setTimer(ms, () => this.fail('timeout', `no playlist was selected within ${ms / 1000} s`));
  }

  event(ev: number, param: number): void {
    if (!this.stopped) this.send({ type: 'event', ev, param });
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
    switch (m.type) {
      case 'booted':
        this.deps.onLog?.(`BD-J booted in ${Math.round(m.bootMs)} ms`, false);
        this.bootDone?.();
        this.bootDone = null;
        break;
      case 'call':
        void this.answer(m.id, m.name, m.args);
        break;
      case 'log':
        this.deps.onLog?.(m.line, m.error);
        break;
      case 'failed':
        this.fail(m.code, m.message);
        break;
    }
  }

  private async answer(id: number, name: BdjCallName, args: readonly BdjWireValue[]): Promise<void> {
    if (name === 'selectPlaylist' && Number(args[0]) >= 0) this.playlistSelected();
    let pending: Promise<number | string>;
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

  private playlistSelected(): void {
    if (this.startedAt === null || this.cancelTimeout === null) return;
    this.cancelTimeout();
    this.cancelTimeout = null;
    this.deps.onLog?.(`BD-J selected its first playlist ${Math.round(this.deps.nowMs() - this.startedAt)} ms after boot`, false);
  }

  private send(m: ToBdj): void {
    if (this.holdFor !== null) this.held.push(m);
    else this.post(m);
  }

  private post(m: ToBdj): void {
    this.deps.worker.postMessage(m);
  }

  private fail(code: BdjFailureCode, message: string): void {
    if (this.stopped) return;
    this.stop();
    this.deps.onFailed(code, message);
  }
}
