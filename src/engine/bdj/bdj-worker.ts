/*
 * Original code for bluray-web: the BD-J worker, which runs the JVM for the engine worker.
 *
 * Copyright (C) 2026  bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { FileSource } from '../disc/file-source';
import { clipInfoPath, loadClips, openDisc } from '../disc/open-disc';
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
      const disc = await openDisc(source);
      const clipIds = new Set([...disc.playlists.values()].flatMap((p) => p.playItems.map((i) => i.clipId)));
      const clips = await loadClips(source, [...clipIds].filter((id) => source.exists(clipInfoPath(id))));
      if (ended) return;
      rt = new BdjRuntime({
        disc: source,
        discId: m.discId,
        classLibrary: m.classLibrary,
        host: () =>
          new WorkerBdjHost({
            regs: new SharedRegisterView(m.registers),
            status: new StatusBlockReader(m.status),
            call,
            disc,
            clips,
            log: (line, error) => {
              hostLine = line;
              post({ type: 'log', line, error });
            },
          }),
        nowMs: () => performance.now(),
        setTimer: (ms, fn) => {
          const id = setTimeout(fn, ms);
          return () => clearTimeout(id);
        },
        log: (line) => {
          if (line === hostLine) hostLine = null;
          else post({ type: 'log', line, error: false });
        },
      });
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
