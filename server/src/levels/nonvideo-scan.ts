import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import type { Clpi } from '../../../src/engine/bdmv/clpi-parser';
import { CodingType, isAudioCoding } from '../../../src/engine/bdmv/stream-types';
import { isCode, replaceAtomically } from '../atomic-json';
import { KeptStreams, PesCoreFilter } from './audio-core';
import type { ClipReader } from './encoder';
import { SOURCE_PACKET_BYTES, coreCoding, type IntervalPlan } from './levels';

/**
 * Bumped whenever the scan counts differently, so a stored scan of an earlier version is scanned again. Part of
 * `planHash` through the budgets it gives.
 */
export const NON_VIDEO_SCAN_VERSION = 1;

const GRAPHICS_CODINGS = new Set<number>([CodingType.PG, CodingType.IG, CodingType.TEXT_SUBTITLE]);

/**
 * What one clip keeps at any level besides its video, per EP interval, in source packets (the scan of spec §5.2's
 * budget): packets are assigned to an interval as the re-mux assigns them (ruling L-R4: a PES by the SPN of its first
 * packet), and each audio stream is counted as the level carries it (TrueHD as its AC-3 core, DTS-HD as its DTS core).
 * One scan serves every level and every audio choice: an interval's kept bytes are `base + graphics + audio[kept PID]`.
 */
export interface NonVideoScan {
  /** The PAT, the PMT (as regenerated) and a PCR PID of its own: kept at every level. */
  readonly base: readonly number[];
  /** Every PG, IG and text subtitle stream: kept at every level, bit-exact. */
  readonly graphics: readonly number[];
  /** By audio PID (decimal): a level keeps one of them. */
  readonly audio: Readonly<Record<string, readonly number[]>>;
}

/** The bytes each interval keeps besides its video, with the audio stream `audioPid` (null: none). */
export function nonVideoBytes(scan: NonVideoScan, audioPid: number | null): number[] {
  const audio = audioPid === null ? undefined : scan.audio[String(audioPid)];
  return scan.base.map((n, i) => (n + scan.graphics[i]! + (audio?.[i] ?? 0)) * SOURCE_PACKET_BYTES);
}

/** Counts a clip's kept packets per interval as its source packets are fed in order from the clip's start. */
export class NonVideoCounter {
  private readonly streams: KeptStreams;
  private readonly base: Uint32Array;
  private readonly graphics: Uint32Array;
  private readonly audio = new Map<number, Uint32Array>();
  private readonly graphicsPids: ReadonlySet<number>;
  private readonly starts: readonly number[];

  constructor(clpi: Clpi, videoPid: number, intervals: readonly Pick<IntervalPlan, 'srcSpnStart'>[]) {
    const streams = clpi.programs.flatMap((p) => p.streams).filter((s) => s.pid !== videoPid);
    this.graphicsPids = new Set(streams.filter((s) => GRAPHICS_CODINGS.has(s.codingType)).map((s) => s.pid));
    const keep = new Set<number>(this.graphicsPids);
    const filters = new Map<number, PesCoreFilter>();
    for (const s of streams) {
      if (!isAudioCoding(s.codingType) || this.audio.has(s.pid)) continue;
      this.audio.set(s.pid, new Uint32Array(intervals.length));
      if (coreCoding(s.codingType) !== s.codingType) filters.set(s.pid, new PesCoreFilter(s.codingType));
      else keep.add(s.pid);
    }
    for (const atc of clpi.atcSequences) for (const stc of atc.stc) if (stc.pcrPid !== videoPid && !this.audio.has(stc.pcrPid)) keep.add(stc.pcrPid);
    const pmtPids = [...new Set(clpi.programs.map((p) => p.programMapPid))];
    // The level's video stream type doesn't change the regenerated PMT's size by a packet; H.264 stands in.
    this.streams = new KeptStreams(keep, filters, { pmtPids, video: { pid: videoPid, streamType: CodingType.AVC } });
    this.base = new Uint32Array(intervals.length);
    this.graphics = new Uint32Array(intervals.length);
    this.starts = intervals.map((iv) => iv.srcSpnStart);
  }

  /** Feeds the source packet at `spn` (a 192-byte view). */
  push(packet: Uint8Array, spn: number): void {
    for (const k of this.streams.filter(packet, spn)) this.count(((k.bytes[5]! & 0x1f) << 8) | k.bytes[6]!, k.spn);
  }

  /** The end of the clip: counts a PES still open, and gives the counts. */
  finish(): NonVideoScan {
    for (const k of this.streams.flush()) this.count(((k.bytes[5]! & 0x1f) << 8) | k.bytes[6]!, k.spn);
    const audio: Record<string, number[]> = {};
    for (const [pid, counts] of this.audio) audio[String(pid)] = [...counts];
    return { base: [...this.base], graphics: [...this.graphics], audio };
  }

  private count(pid: number, spn: number): void {
    const i = this.intervalOf(spn);
    const audio = this.audio.get(pid);
    if (audio) audio[i]!++;
    else if (this.graphicsPids.has(pid)) this.graphics[i]!++;
    else this.base[i]!++;
  }

  /** The interval holding `spn`: the last one starting at or before it. */
  private intervalOf(spn: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= spn) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}

/**
 * Reads a whole clip once and counts what each interval keeps besides its video. About 200 MB/s on the NAS's disks, so
 * minutes for a long film: the result is stored (`NonVideoStore`) and never read again for the same clip. An abort of
 * `signal` stops the read and rejects.
 */
export async function scanNonVideo(
  read: ClipReader,
  clpi: Clpi,
  videoPid: number,
  intervals: readonly Pick<IntervalPlan, 'srcSpnStart'>[],
  signal?: AbortSignal,
): Promise<NonVideoScan> {
  const counter = new NonVideoCounter(clpi, videoPid, intervals);
  const stream: Readable = read(0);
  const stop = (): void => {
    stream.destroy(new Error('levels: the scan was stopped'));
  };
  if (signal?.aborted) stop();
  signal?.addEventListener('abort', stop, { once: true });
  try {
    let spn = 0;
    let partial = new Uint8Array(0);
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      let data = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      if (partial.length) {
        const joined = new Uint8Array(partial.length + data.length);
        joined.set(partial);
        joined.set(data, partial.length);
        data = joined;
      }
      const whole = data.length - (data.length % SOURCE_PACKET_BYTES);
      for (let at = 0; at < whole; at += SOURCE_PACKET_BYTES) counter.push(data.subarray(at, at + SOURCE_PACKET_BYTES), spn++);
      partial = data.slice(whole);
    }
    if (signal?.aborted) throw new Error('levels: the scan was stopped');
    return counter.finish();
  } finally {
    signal?.removeEventListener('abort', stop);
    stream.destroy();
  }
}

/** Where a clip's scan is stored: its identity (size and mtime) and the intervals it was counted over. */
export interface NonVideoKey {
  readonly discId: string;
  readonly clipId: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly intervals: readonly Pick<IntervalPlan, 'srcSpnStart'>[];
}

export interface NonVideoStore {
  get(key: NonVideoKey): Promise<NonVideoScan | null>;
  put(key: NonVideoKey, scan: NonVideoScan): Promise<void>;
}

const PART_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** The intervals' starts, hashed: a stored scan counted over other intervals (another CLPI) is not used. */
function intervalsHash(intervals: readonly Pick<IntervalPlan, 'srcSpnStart'>[]): string {
  return createHash('sha256')
    .update(intervals.map((iv) => iv.srcSpnStart).join(','))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Scans on disk, one JSON file per clip: `<dir>/<discId>/<clipId>.json`, holding the clip's size, mtime and intervals'
 * hash, so a replaced clip or changed CLPI is scanned again (and its file replaced). Written atomically. A few hundred KB
 * for a long film; never evicted.
 */
export class FileNonVideoStore implements NonVideoStore {
  constructor(private readonly dir: string) {}

  async get(key: NonVideoKey): Promise<NonVideoScan | null> {
    const path = this.pathOf(key);
    if (!path) return null;
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      if (isCode(err, 'ENOENT')) return null;
      throw err;
    }
    try {
      const stored = JSON.parse(text) as { version?: unknown; size?: unknown; mtimeMs?: unknown; intervals?: unknown; scan?: NonVideoScan };
      if (stored.version !== NON_VIDEO_SCAN_VERSION || stored.size !== key.size || stored.mtimeMs !== key.mtimeMs || stored.intervals !== intervalsHash(key.intervals)) return null;
      const scan = stored.scan;
      const n = key.intervals.length;
      const fits = (a: unknown): boolean => Array.isArray(a) && a.length === n && a.every((v) => Number.isSafeInteger(v) && v >= 0);
      if (!scan || !fits(scan.base) || !fits(scan.graphics) || typeof scan.audio !== 'object' || scan.audio === null || !Object.values(scan.audio).every(fits)) return null;
      return scan;
    } catch {
      return null; // a damaged file: scanned again
    }
  }

  async put(key: NonVideoKey, scan: NonVideoScan): Promise<void> {
    const path = this.pathOf(key);
    if (!path) return;
    await mkdir(dirname(path), { recursive: true });
    replaceAtomically(path, JSON.stringify({ version: NON_VIDEO_SCAN_VERSION, size: key.size, mtimeMs: key.mtimeMs, intervals: intervalsHash(key.intervals), scan }));
  }

  private pathOf(key: NonVideoKey): string | null {
    if (!PART_RE.test(key.discId) || !PART_RE.test(key.clipId)) return null;
    return join(this.dir, key.discId, `${key.clipId}.json`);
  }
}
