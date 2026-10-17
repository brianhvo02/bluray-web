/// <reference lib="webworker" />
import { parseClpi } from '../engine/bdmv/clpi-parser';
import { CodingType } from '../engine/bdmv/stream-types';
import { analyzeHevc, hevcCodecString } from '../engine/decode/hevc';
import { FileSource } from '../engine/disc/file-source';
import { normalizeDiscPaths } from '../engine/disc/paths';
import { M2tsReader } from '../engine/demux/m2ts-reader';
import type { WorkerProbe } from './checks';

const scope = self as unknown as DedicatedWorkerGlobalScope & { requestAnimationFrame?: (cb: (t: number) => void) => number };

async function timerP95(): Promise<{ present: boolean; p95Ms: number }> {
  const present = typeof scope.requestAnimationFrame === 'function';
  const intervals: number[] = [];
  let last = performance.now();
  await new Promise<void>((resolve) => {
    const tick = (): void => {
      const now = performance.now();
      intervals.push(now - last);
      last = now;
      if (intervals.length >= 120) resolve();
      else if (present) scope.requestAnimationFrame?.(tick);
      else setTimeout(tick, 16);
    };
    if (present) scope.requestAnimationFrame?.(tick);
    else setTimeout(tick, 16);
  });
  intervals.sort((a, b) => a - b);
  return { present, p95Ms: intervals[Math.min(intervals.length - 1, Math.floor(intervals.length * 0.95))] };
}

function webgl(): { float: boolean; half: boolean } {
  const gl = new OffscreenCanvas(1, 1).getContext('webgl2');
  if (!gl) return { float: false, half: false };
  return { float: !!gl.getExtension('EXT_color_buffer_float'), half: !!gl.getExtension('EXT_color_buffer_half_float') };
}

async function supported(codec: string): Promise<boolean> {
  try {
    return (await VideoDecoder.isConfigSupported({ codec })).supported === true;
  } catch {
    return false;
  }
}

async function hevc(files: readonly File[]): Promise<WorkerProbe['hevc']> {
  const entries = files.map((f) => [f.webkitRelativePath || f.name, f] as const);
  const source = new FileSource(normalizeDiscPaths(entries));
  let target: { clip: string; pid: number } | null = null;
  for (const name of source.list('BDMV/CLIPINF')) {
    if (!name.endsWith('.CLPI')) continue;
    const clpi = parseClpi(await source.read(`BDMV/CLIPINF/${name}`, 0, source.size(`BDMV/CLIPINF/${name}`)));
    const stream = clpi.programs.flatMap((p) => p.streams).find((s) => s.codingType === CodingType.HEVC);
    if (stream) {
      target = { clip: name.replace(/\.CLPI$/, ''), pid: stream.pid };
      break;
    }
  }
  if (!target) return null;

  const reader = new M2tsReader({ source, path: `BDMV/STREAM/${target.clip}.M2TS`, startSpn: 0, pids: new Set([target.pid]) });
  const units: { data: Uint8Array; pts: number; key: boolean }[] = [];
  let codec: string | null = null;
  try {
    for (let packets = await reader.next(); packets && units.length < 90; packets = await reader.next()) {
      for (const pes of packets) {
        if (pes.pid !== target.pid) continue;
        const info = analyzeHevc(pes.payload);
        if (units.length === 0 && !info.key) continue;
        if (units.length > 0 && info.key) {
          packets = null; // the next GOP starts here
          break;
        }
        if (info.sps && !codec) codec = hevcCodecString(info.sps);
        units.push({ data: pes.payload, pts: pes.pts ?? 0, key: info.key });
      }
      if (!packets) break;
    }
  } finally {
    reader.cancel();
  }
  if (!codec) return { hvc1: false, hev1: false, decoded: false };

  const hev1 = codec;
  const hvc1 = `hvc1${codec.slice(4)}`;
  const result = { hvc1: await supported(hvc1), hev1: await supported(hev1), decoded: false };
  const chosen = result.hvc1 ? hvc1 : result.hev1 ? hev1 : null;
  if (!chosen) return result;

  let frames = 0;
  const decoder = new VideoDecoder({
    output: (frame) => {
      frames++;
      frame.close();
    },
    error: () => undefined,
  });
  try {
    decoder.configure({ codec: chosen });
    for (const u of units) decoder.decode(new EncodedVideoChunk({ type: u.key ? 'key' : 'delta', timestamp: u.pts, data: u.data }));
    await Promise.race([decoder.flush(), new Promise((resolve) => setTimeout(resolve, 5000))]);
  } catch {
    // leaves decoded false
  }
  result.decoded = frames > 0;
  if (decoder.state !== 'closed') decoder.close();
  return result;
}

scope.onmessage = async (event: MessageEvent<{ files: File[] }>) => {
  const { files } = event.data;
  const [raf, gl, hevcResult] = await Promise.all([
    timerP95(),
    Promise.resolve().then(webgl).catch(() => ({ float: false, half: false })),
    hevc(files).catch(() => null),
  ]);
  const probe: WorkerProbe = { hevc: hevcResult, raf, webgl: gl };
  scope.postMessage(probe);
};
