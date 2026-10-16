import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { directoryEntries } from '../helpers/file-blob';
import { normalizeDiscPaths } from '../../src/engine/disc/paths';
import { FileSource } from '../../src/engine/disc/file-source';
import { loadClips, openDisc } from '../../src/engine/disc/open-disc';
import { RecordingHost } from '../../src/engine/bdj/host';
import type { TraceEntry } from '../../src/engine/bdj/host';
import { BdjRuntime } from '../../src/engine/bdj/runtime';

const FIRST_PLAY = 0xffff;
const jar = (name: string): Uint8Array => new Uint8Array(readFileSync(fileURLToPath(new URL(`../../src/bdj-classlib/${name}`, import.meta.url))));

export interface BdjReplay {
  readonly trace: TraceEntry[];
  readonly bootMs: number;
  readonly untilMs: number;
}

/**
 * Boots the BD-J stack on a disc directory, starts First Play and runs until a trace entry with call name `until`
 * (or until idle), on the real clock so multi-second local-disc runs behave as on a device.
 */
export async function replayBdj(discDir: URL | string, opts: { until?: string; timeoutMs?: number } = {}): Promise<BdjReplay> {
  const dir = typeof discDir === 'string' ? discDir : fileURLToPath(discDir);
  const source = new FileSource(normalizeDiscPaths(await directoryEntries(dir)));
  const disc = await openDisc(source);
  const clips = await loadClips(source, [...new Set([...disc.playlists.values()].flatMap((p) => p.playItems.map((i) => i.clipId)))]);
  let host: RecordingHost | null = null;
  const rt = new BdjRuntime({
    disc: source,
    classLibrary: { rt: jar('rt-bdj.jar'), libbluray: jar('libbluray-j2se.jar'), libblurayAwt: jar('libbluray-awt-j2se.jar') },
    host: (startTitle, onTrace) => (host = new RecordingHost(disc, clips, { startTitle, onTrace })),
    nowMs: () => Date.now(),
    setTimer: (ms, fn) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
    log: () => {},
  });
  const ac = new AbortController();
  let booted = false;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const timeout = setTimeout(() => {
    ac.abort();
    if (!booted) rt.jvm.threads.halt();
  }, timeoutMs);
  const calls = (): number => host?.trace.length ?? 0;
  try {
    const t0 = performance.now();
    const bootTimeout = (cause: string): Error => new Error(`replayBdj: boot timed out after ${timeoutMs} ms${cause}`);
    try {
      await rt.boot();
    } catch (e) {
      if (ac.signal.aborted) throw bootTimeout(` (${String(e)})`);
      throw e;
    }
    if (ac.signal.aborted) throw bootTimeout('');
    booted = true;
    const bootMs = performance.now() - t0;
    rt.start(FIRST_PLAY);
    const until = opts.until;
    const outcome = await rt.run(until === undefined ? { signal: ac.signal } : { signal: ac.signal, until: (e) => e.call === until });
    if (until !== undefined && outcome !== 'until') {
      throw new Error(
        `replayBdj: run ended '${outcome}' before ${until} (timed out: ${ac.signal.aborted}, exit status ${rt.exitStatus ?? 'none'}, ${calls()} calls traced)`,
      );
    }
    return { trace: [...(host?.trace ?? [])], bootMs, untilMs: performance.now() - t0 };
  } finally {
    clearTimeout(timeout);
    rt.jvm.threads.halt();
  }
}
