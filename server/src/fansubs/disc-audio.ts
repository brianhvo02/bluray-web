import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { findEpAfter, findEpBefore, parseClpi, type Clpi } from '../../../src/engine/bdmv/clpi-parser';
import { parseMpls, type PlayItem } from '../../../src/engine/bdmv/mpls-parser';
import { readTimestamp } from '../../../src/engine/demux/pes-assembler';
import { parseSourcePacket } from '../../../src/engine/demux/ts-packet';
import type { LevelDiscSource } from '../levels/level-discs';

const SOURCE_PACKET = 192;
const SAMPLES_PER_MS = 16;
const PTS_WRAP = 2 ** 33;
/** How far outside a window the byte range reaches, in 45 kHz ticks: audio is muxed a little before or after its video. */
const MARGIN_45 = 22_500;

/** 16 kHz mono PCM of one stretch of a playlist; `startMs` is the playlist time of `pcm[0]`. */
export interface AudioWindow {
  readonly startMs: number;
  readonly pcm: Int16Array;
}

export interface TimeWindow {
  readonly fromMs: number;
  readonly toMs: number;
}

/**
 * Up to six windows of a minute, evenly spread over the middle of an episode (the first and last minute and a half hold
 * openings, endings and previews): fewer and shorter ones when it is under nine minutes, the whole of it when under three.
 */
export function windowsFor(durationMs: number): TimeWindow[] {
  const margin = 90_000;
  const span = durationMs - 2 * margin;
  if (durationMs < 180_000 || span <= 0) return [{ fromMs: 0, toMs: durationMs }];
  const count = Math.max(1, Math.min(6, Math.floor(span / 30_000)));
  const length = Math.min(60_000, Math.floor(span / count));
  const step = count === 1 ? 0 : (span - length) / (count - 1);
  return Array.from({ length: count }, (_, i) => {
    const fromMs = margin + Math.round(i * step);
    return { fromMs, toMs: fromMs + length };
  });
}

/** Cuts an m2ts stream into whole source packets, drops the audio PID's packets before its first PES start, and reports that PES's PTS. */
async function feed(stream: Readable, pid: number, write: (bytes: Uint8Array) => Promise<void>, signal?: AbortSignal): Promise<number | null> {
  let carry: Buffer = Buffer.alloc(0);
  let firstPts: number | null = null;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    if (signal?.aborted) break;
    const bytes = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    const whole = bytes.length - (bytes.length % SOURCE_PACKET);
    carry = bytes.subarray(whole);
    const kept: Buffer[] = [];
    for (let at = 0; at < whole; at += SOURCE_PACKET) {
      if (firstPts === null) {
        const p = parseSourcePacket(bytes, at);
        if (p && p.pid === pid) {
          const pl = p.payload;
          const startsPes = p.payloadUnitStart && pl.length >= 14 && pl[0] === 0 && pl[1] === 0 && pl[2] === 1 && (pl[7] & 0x80) !== 0;
          if (!startsPes) continue;
          firstPts = readTimestamp(pl, 9);
        }
      }
      kept.push(bytes.subarray(at, at + SOURCE_PACKET));
    }
    if (kept.length) await write(Buffer.concat(kept));
  }
  return firstPts;
}

/** Decodes the audio PID of a byte range of a clip to 16 kHz mono s16le. */
async function decodeRange(read: Readable, pid: number, ffmpegPath: string, signal?: AbortSignal): Promise<{ firstPts: number; pcm: Int16Array } | null> {
  const ff = spawn(ffmpegPath, [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'mpegts', '-i', 'pipe:0', '-map', `0:#0x${pid.toString(16)}`,
    '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  const out: Buffer[] = [];
  let stderr = '';
  ff.stdout.on('data', (d: Buffer) => out.push(d));
  ff.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  ff.stdin.on('error', () => {}); // ffmpeg may stop reading early; its exit code says why
  const closed = new Promise<number | null>((resolve, reject) => {
    ff.on('error', reject);
    ff.on('close', resolve);
  });
  const onAbort = (): void => {
    ff.kill('SIGKILL');
    read.destroy();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal?.aborted) onAbort();
    const write = (bytes: Uint8Array): Promise<void> =>
      new Promise((resolve) => {
        if (ff.stdin.write(bytes)) resolve();
        else ff.stdin.once('drain', () => resolve());
      });
    let firstPts: number | null;
    try {
      firstPts = await feed(read, pid, write, signal);
    } catch (err) {
      if (!signal?.aborted) throw err;
      firstPts = null;
    }
    ff.stdin.end();
    const code = await closed;
    signal?.throwIfAborted();
    if (firstPts === null) return null;
    const bytes = Buffer.concat(out);
    if (code !== 0 && bytes.length === 0) throw new Error(`disc audio: ffmpeg exited ${code}: ${stderr.trim().slice(0, 300)}`);
    const pcm = new Int16Array(bytes.length >> 1);
    for (let i = 0; i < pcm.length; i++) pcm[i] = bytes.readInt16LE(i * 2);
    return { firstPts, pcm };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (ff.exitCode === null) ff.kill('SIGKILL');
  }
}

/**
 * 16 kHz mono PCM of windows of a playlist's first audio stream, reading only the bytes each window needs (from the EP
 * entry before it to the one after it). A window is `[fromMs, toMs)` in playlist time, clamped to the playlist; `startMs`
 * is its start, exact to 10 ms: each decoded stretch is placed by the PTS of its first audio PES, and gaps are silence.
 */
export async function episodeAudio(
  disc: LevelDiscSource,
  playlistId: string,
  windows: readonly TimeWindow[] | 'whole',
  ffmpegPath: string,
  signal?: AbortSignal,
): Promise<AudioWindow[]> {
  const mplsBytes = await disc.readFile(`BDMV/PLAYLIST/${playlistId}.mpls`);
  if (!mplsBytes) throw new Error(`disc audio: no playlist ${playlistId}`);
  const mpls = parseMpls(mplsBytes);
  const items: Array<{ item: PlayItem; startMs: number; endMs: number }> = [];
  let at = 0;
  for (const item of mpls.playItems) {
    const ms = (item.outTime - item.inTime) / 45;
    items.push({ item, startMs: at, endMs: at + ms });
    at += ms;
  }
  const durationMs = at;
  const pid = items[0]?.item.stn.audio[0]?.pid;
  if (pid === undefined) throw new Error(`disc audio: playlist ${playlistId} has no audio stream`);
  const clpis = new Map<string, Clpi>();
  const clpiOf = async (clipId: string): Promise<Clpi> => {
    let clpi = clpis.get(clipId);
    if (!clpi) {
      const bytes = await disc.readFile(`BDMV/CLIPINF/${clipId}.clpi`);
      if (!bytes) throw new Error(`disc audio: no clip info ${clipId}`);
      clpi = parseClpi(bytes);
      clpis.set(clipId, clpi);
    }
    return clpi;
  };

  const spans = windows === 'whole' ? [{ fromMs: 0, toMs: durationMs }] : windows;
  const result: AudioWindow[] = [];
  for (const w of spans) {
    const fromMs = Math.max(0, w.fromMs);
    const toMs = Math.min(durationMs, w.toMs);
    const pcm = new Int16Array(Math.max(0, Math.round((toMs - fromMs) * SAMPLES_PER_MS)));
    for (const { item, startMs, endMs } of items) {
      const itemFrom = Math.max(fromMs, startMs);
      const itemTo = Math.min(toMs, endMs);
      if (itemFrom >= itemTo) continue;
      signal?.throwIfAborted();
      const clpi = await clpiOf(item.clipId);
      const map = clpi.epMaps[0];
      const clip = await disc.clip(`BDMV/STREAM/${item.clipId}.m2ts`);
      if (!clip) throw new Error(`disc audio: no clip ${item.clipId}`);
      const from45 = item.inTime + (itemFrom - startMs) * 45;
      const to45 = item.inTime + (itemTo - startMs) * 45;
      const first = map && findEpBefore(map, from45 - MARGIN_45);
      const last = map && findEpAfter(map, to45 + MARGIN_45);
      const fromByte = (first?.spn ?? 0) * SOURCE_PACKET;
      const toByte = last ? last.spn * SOURCE_PACKET : clpi.numSourcePackets * SOURCE_PACKET;
      const decoded = await decodeRange(clip.read(fromByte, toByte), pid, ffmpegPath, signal);
      if (!decoded) continue;
      // PTS of the first sample, as playlist time (33-bit wrap folded into the nearest side of the play item's in-time).
      let delta = (decoded.firstPts - item.inTime * 2) % PTS_WRAP;
      if (delta > PTS_WRAP / 2) delta -= PTS_WRAP;
      else if (delta < -PTS_WRAP / 2) delta += PTS_WRAP;
      const pieceStartMs = startMs + delta / 90;
      const pieceStart = Math.round((pieceStartMs - fromMs) * SAMPLES_PER_MS);
      const lo = Math.max(pieceStart, Math.round((itemFrom - fromMs) * SAMPLES_PER_MS), 0);
      const hi = Math.min(pieceStart + decoded.pcm.length, Math.round((itemTo - fromMs) * SAMPLES_PER_MS), pcm.length);
      if (lo < hi) pcm.set(decoded.pcm.subarray(lo - pieceStart, hi - pieceStart), lo);
    }
    result.push({ startMs: fromMs, pcm });
  }
  return result;
}
