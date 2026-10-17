/*
 * Original code for bluray-web: the BD-J worker, which runs the JVM for the engine worker.
 *
 * Copyright (C) 2026  bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { Clpi } from '../bdmv/clpi-parser';
import { FileSource } from '../disc/file-source';
import { HttpSource } from '../disc/http-source';
import { clipInfoPath, loadClips, openDisc } from '../disc/open-disc';
import type { DiscModel } from '../disc/open-disc';
import { normalizeDiscPaths } from '../disc/paths';
import { BdjError } from './errors';
import type { FreeType } from './fonts/freetype';
import type { NativeTable } from './jvm/natives/index';
import { GraphicsPlaneWriter } from './graphics-plane';
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

export interface BdjWorkerOptions {
  /** JvmOptions.extraIntrinsics: the class library's intrinsics (src/bdj-classlib/intrinsics), which the engine does not carry. */
  readonly extraIntrinsics?: (table: NativeTable) => void;
  /**
   * FreeType for the BD-J text natives (java_awt_BDFontMetrics.c, java_awt_BDGraphics.c), loaded when text is first
   * needed, not at boot: the entry fetches src/wasm/freetype/freetype.wasm. Calls share one load.
   */
  readonly loadFreeType?: () => Promise<FreeType>;
  /** The bundled fallback font (src/engine/ass/default-font.ttf), the JRE font files' bytes; fetched when first read. */
  readonly loadDefaultFont?: () => Promise<Uint8Array>;
}

/** Serves one BD-J session over `port`: boot, then title starts, events and call replies in arrival order. */
export function runBdjWorker(port: BdjPort, options: BdjWorkerOptions = {}): BdjWorkerHandle {
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
      else rt!.processEvent(m.ev, m.param, m.coalesce);
    } catch (e) {
      fail(e);
      return;
    }
    kick();
  };

  const boot = async (m: BootMessage): Promise<void> => {
    const t0 = performance.now();
    try {
      const source = m.discHttp ? await HttpSource.open(m.discHttp.baseUrl, m.discHttp.token) : new FileSource(normalizeDiscPaths(m.discFiles));
      // the disc model loads while the JDK starts up; the host reads it once Libbluray.init asks for disc info
      let model: { readonly disc: DiscModel; readonly clips: ReadonlyMap<string, Clpi> } | null = null;
      const loading = (async () => {
        const disc = await openDisc(source);
        const clipIds = new Set([...disc.playlists.values()].flatMap((p) => p.playItems.map((i) => i.clipId)));
        // openDisc has already parsed the clips of a disc with movie objects; only the rest are read here
        const rest = await loadClips(source, [...clipIds].filter((id) => !disc.clips.has(id) && source.exists(clipInfoPath(id))));
        model = { disc, clips: new Map([...disc.clips, ...rest]) };
      })();
      loading.catch(() => undefined); // awaited below; this only keeps a failure while the runtime is set up from going unhandled
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
            plane: new GraphicsPlaneWriter(m.plane),
            background: (image, rect) => post({ type: 'background', image, rect }),
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
        ...(options.extraIntrinsics ? { extraIntrinsics: options.extraIntrinsics } : {}),
        ...(options.loadFreeType && options.loadDefaultFont
          ? { fonts: { loadFreeType: options.loadFreeType, loadDefaultFont: options.loadDefaultFont } }
          : {}),
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
    }
  };

  return {
    get runtime() {
      return rt;
    },
  };
}
