/*
 * Original code for bluray-web: the BD-J worker, which runs the JVM for the engine worker.
 *
 * Copyright (C) 2026  bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { Clpi } from '../bdmv/clpi-parser';
import { FileSource } from '../disc/file-source';
import { clipInfoPath, loadClips, openDisc } from '../disc/open-disc';
import type { DiscModel } from '../disc/open-disc';
import { normalizeDiscPaths } from '../disc/paths';
import { BdjError } from './errors';
import { BdjRuntime } from './runtime';
import { SharedRegisterView } from './shared-registers';
import { StatusBlockReader } from './status-block';
import { WorkerBdjHost } from './worker-host';
import type { BdjCallName, BdjFailureCode, BdjWireValue, FromBdj, ToBdj } from './worker-protocol';

export interface BdjPort {
  postMessage(message: FromBdj): void;
  onmessage: ((event: { readonly data: ToBdj }) => void) | null;
}

export interface BdjWorkerHandle {
  /** The runtime once booting has begun (tests reach into the JVM through it). */
  readonly runtime: BdjRuntime | null;
}

type BootMessage = Extract<ToBdj, { type: 'boot' }>;
type TitleMessage = Extract<ToBdj, { type: 'start' | 'event' }>;

/**
 * A macrotask turn without timer clamping, for the JVM scheduler's periodic yield: a MessageChannel message in a
 * browser (setTimeout(0) there waits 4 ms once timers nest), setImmediate where it exists.
 */
function eventLoopTurn(): () => Promise<void> {
  const immediate = (globalThis as { setImmediate?: (fn: () => void) => unknown }).setImmediate;
  if (immediate) return () => new Promise<void>((resolve) => void immediate(resolve));
  if (typeof MessageChannel !== 'function') return () => new Promise<void>((resolve) => void setTimeout(resolve, 0));
  const channel = new MessageChannel();
  const waiting: (() => void)[] = [];
  channel.port1.onmessage = () => waiting.shift()?.();
  return () =>
    new Promise<void>((resolve) => {
      waiting.push(resolve);
      channel.port2.postMessage(null);
    });
}

/** Serves one BD-J session over `port`: boot, then title starts, events and call replies in arrival order. */
export function runBdjWorker(port: BdjPort): BdjWorkerHandle {
  let rt: BdjRuntime | null = null;
  let booted = false;
  let ended = false;
  const waiting: TitleMessage[] = [];
  const replies = new Map<number, (value: number | string) => void>();
  let nextId = 1;
  let looping = false;
  let dirty = false;
  let driving: AbortController | null = null;
  /** The runtime's log repeats each line the host logs; the host's copy carries the error flag. */
  let hostLine: string | null = null;

  const post = (m: FromBdj): void => {
    if (!ended) port.postMessage(m);
  };

  const fail = (e: unknown): void => {
    if (ended) return;
    let code: BdjFailureCode = 'internal';
    let message = e instanceof Error ? e.message : String(e);
    if (rt?.exitStatus != null) {
      code = 'halted';
      message = `the JVM halted with status ${rt.exitStatus}`;
    } else if (e instanceof BdjError) {
      code = e.code;
    }
    post({ type: 'failed', code, message });
    ended = true;
    driving?.abort();
    rt?.jvm.threads.halt();
  };

  const call = (name: BdjCallName, args: readonly BdjWireValue[]): Promise<number | string> => {
    const id = nextId++;
    return new Promise((resolve) => {
      replies.set(id, resolve);
      post({ type: 'call', id, name, args });
    });
  };

  /** Runs the Java threads until they idle; a message that gives them work runs them again. */
  const kick = (): void => {
    if (ended || !booted) return;
    dirty = true;
    if (looping) {
      driving?.abort();
      return;
    }
    looping = true;
    void (async () => {
      try {
        while (dirty && !ended) {
          dirty = false;
          driving = new AbortController();
          await rt!.run({ signal: driving.signal });
          if (rt!.exitStatus !== null) fail(null);
        }
      } catch (e) {
        fail(e);
      } finally {
        looping = false;
        driving = null;
      }
    })();
  };

  const deliver = (m: TitleMessage): void => {
    try {
      if (m.type === 'start') rt!.start(m.title);
      else rt!.processEvent(m.ev, m.param);
    } catch (e) {
      fail(e);
      return;
    }
    kick();
  };

  const boot = async (m: BootMessage): Promise<void> => {
    const t0 = performance.now();
    try {
      const source = new FileSource(normalizeDiscPaths(m.discFiles));
      // the disc model loads while the JDK starts up; the host reads it once Libbluray.init asks for disc info
      let model: { readonly disc: DiscModel; readonly clips: ReadonlyMap<string, Clpi> } | null = null;
      const loading = (async () => {
        const disc = await openDisc(source);
        const clipIds = new Set([...disc.playlists.values()].flatMap((p) => p.playItems.map((i) => i.clipId)));
        model = { disc, clips: await loadClips(source, [...clipIds].filter((id) => source.exists(clipInfoPath(id)))) };
      })();
      const loaded = (): NonNullable<typeof model> => {
        if (!model) throw new Error('the disc model is not loaded yet');
        return model;
      };
      rt = new BdjRuntime({
        disc: source,
        discId: m.discId,
        classLibrary: m.classLibrary,
        host: () =>
          new WorkerBdjHost({
            regs: new SharedRegisterView(m.registers),
            status: new StatusBlockReader(m.status),
            call,
            get disc() {
              return loaded().disc;
            },
            get clips() {
              return loaded().clips;
            },
            log: (line, error) => {
              hostLine = line;
              post({ type: 'log', line, error });
            },
          }),
        // the wall clock (System.currentTimeMillis), kept monotonic: Java's timers and dates both read it
        nowMs: () => performance.timeOrigin + performance.now(),
        setTimer: (ms, fn) => {
          const id = setTimeout(fn, ms);
          return () => clearTimeout(id);
        },
        yieldTask: eventLoopTurn(),
        log: (line) => {
          if (line === hostLine) hostLine = null;
          else post({ type: 'log', line, error: false });
        },
      });
      // boot() reports a JDK failure itself, with its BdjError code
      await Promise.all([loading, rt.bootJdk().catch(() => undefined)]);
      if (ended) return;
      await rt.boot();
    } catch (e) {
      fail(e);
      return;
    }
    if (ended) return;
    booted = true;
    post({ type: 'booted', bootMs: performance.now() - t0 });
    for (const w of waiting.splice(0)) deliver(w);
  };

  port.onmessage = ({ data: m }) => {
    if (ended) return;
    switch (m.type) {
      case 'boot':
        void boot(m);
        break;
      case 'start':
      case 'event':
        if (booted) deliver(m);
        else waiting.push(m);
        break;
      case 'reply': {
        const resolve = replies.get(m.id);
        replies.delete(m.id);
        resolve?.(m.value);
        if (!looping) kick();
        break;
      }
      case 'stop':
        ended = true;
        driving?.abort();
        void rt?.stop().catch(() => undefined);
        break;
    }
  };

  return {
    get runtime() {
      return rt;
    },
  };
}

const workerScope = globalThis as { WorkerGlobalScope?: abstract new () => unknown };
if (workerScope.WorkerGlobalScope && globalThis instanceof workerScope.WorkerGlobalScope) {
  runBdjWorker(globalThis as unknown as BdjPort);
}
