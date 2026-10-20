import type { spawn as nodeSpawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { parseClpi, type Clpi } from '../../../src/engine/bdmv/clpi-parser';
import { parseMpls, type Mpls, type PlayItem } from '../../../src/engine/bdmv/mpls-parser';
import { CodingType } from '../../../src/engine/bdmv/stream-types';
import type { DiscEntry, DiscManifest } from '../../../src/engine/disc/nas-api';
import type { UdfFile } from '../../../src/engine/disc/udf';
import { IsoTrees, isoFileStream, isoUnchanged, readIsoFiles } from '../iso';
import type { Library } from '../library';
import { buildIsoManifest, buildManifest, discUnchanged, resolveDiscFile, resolveIsoFile } from '../manifest';
import { nominalAudioBps, PesCoreFilter } from './audio-core';
import type { Capacity, EncoderCodec } from './capacity';
import { ClipRunner, realClock, type Clock, type ClipRunPlan } from './clip-run';
import { rewriteClpi } from './clpi-writer';
import { deinterlaces, probeScan, type ClipInput, type ClipReader, type EncoderBackend, type ScanInfo } from './encoder';
import {
  SOURCE_PACKET_BYTES,
  coreCoding,
  keptAudioFor,
  levelDefFor,
  levelsFor,
  planClip,
  videoAttrsFor,
  videoEpMap,
  type IntervalPlan,
  type KeptAudio,
  type LevelDef,
  type LevelId,
} from './levels';
import { rewriteMpls } from './mpls-writer';
import type { SegmentCache } from './segment-cache';

/** Film the encoder runs ahead of the latest read; a read this far ahead of it waits (spec §6.1). */
export const READ_AHEAD_FILM_MS = 120_000;
/** A read waiting this long answers `retryAfter` (spec §6.1). */
export const READ_WAIT_MS = 15_000;
/** An encoder no read has touched for this long stops (spec §6.1). */
export const ENCODER_IDLE_MS = 60_000;
/** Where a clip's first audio frame is looked for. */
const AUDIO_PROBE_BYTES = 16 * 1024 * 1024;
const DISC_INFOS = 16;
const VERSIONS = 32;

export type EncodedLevel = Exclude<LevelId, 'original'>;

/** A stream file of a disc: what ffmpeg reads, how the server reads it, and its identity for the cache key. */
export interface ClipSource {
  readonly input: ClipInput;
  readonly read: ClipReader;
  readonly size: number;
  readonly mtimeMs: number;
}

/** One disc's original files, as the level service reads them. Paths are disc-relative and upper-case. */
export interface LevelDiscSource {
  manifest(): Promise<DiscManifest>;
  /** A whole file (a CLPI or MPLS the manifest didn't inline), or null. */
  readFile(path: string): Promise<Uint8Array | null>;
  /** Bytes [offset, offset + length) of a file, or null when it is missing. */
  readRange(path: string, offset: number, length: number): Promise<Buffer | null>;
  clip(path: string): Promise<ClipSource | null>;
}

export type LevelReason = 'unplayable' | 'no-hevc' | 'no-hevc10' | 'no-hdr-display' | 'busy';

export interface LevelInfo {
  readonly level: LevelId;
  readonly label: string;
  /** The rate the level travels at (its byte budget over the main clip's film, padding included), Mbps to 0.1. */
  readonly budgetMbps: number;
  readonly available: boolean;
  readonly reason?: LevelReason;
}

const LABELS: Readonly<Record<LevelId, string>> = {
  original: 'Original',
  'h264-1080': '1080p',
  'phone-720': 'Phone',
  'hevc-1080': '1080p HEVC',
  'hevc-1080-hdr': '1080p HDR',
  'h264-1080-sdr': '1080p SDR',
};

const ENCODED_LEVELS = new Set<string>(['h264-1080', 'phone-720', 'hevc-1080', 'hevc-1080-hdr', 'h264-1080-sdr']);

/** The viewing a lease is for (spec §6.4): a device watching a disc at a level and audio stream. */
export function viewingIdOf(deviceId: string, discId: string, level: EncodedLevel, audio: number): string {
  return `${deviceId}:${discId}:${level}:${audio}`;
}

/** The device-and-disc part of a viewing id: the viewings one lease moves between. */
function viewerOf(viewingId: string): string {
  const audioAt = viewingId.lastIndexOf(':');
  return viewingId.slice(0, viewingId.lastIndexOf(':', audioAt - 1) + 1);
}

export interface LevelServiceOptions {
  /** A disc's files by its id; null when it is gone or changed. */
  readonly discs: (discId: string) => Promise<LevelDiscSource | null>;
  readonly cache: SegmentCache;
  readonly capacity: Capacity;
  readonly backend: EncoderBackend;
  /** Injectable for tests: how ffmpeg is started. */
  readonly spawn?: typeof nodeSpawn;
  /** Injectable for tests: the scan probe (ffprobe). */
  readonly probe?: (input: ClipInput, options: { readonly startByte: number; readonly videoPid: number }) => Promise<ScanInfo>;
  readonly clock?: Clock;
  readonly readAheadMs?: number;
  readonly waitMs?: number;
  readonly idleMs?: number;
  readonly log?: (message: string) => void;
}

interface VideoInfo {
  readonly pid: number;
  readonly codingType: number;
  readonly height: number;
  /** CLPI frame-rate code. */
  readonly rate: number;
  readonly hdr: boolean;
}

interface ClipInfo {
  readonly id: string;
  readonly clpiPath: string;
  readonly m2tsPath: string;
  readonly clpiBytes: Uint8Array;
  readonly clpi: Clpi;
  readonly video: VideoInfo;
  /** The first main-path play item that plays this clip: its STN picks the clip's kept audio. */
  readonly item: PlayItem;
}

interface DiscInfo {
  readonly id: string;
  readonly source: LevelDiscSource;
  readonly manifest: DiscManifest;
  readonly sizes: ReadonlyMap<string, number>;
  readonly playlists: readonly { readonly path: string; readonly bytes: Uint8Array; readonly clipIds: readonly string[] }[];
  /** The clips with primary video that a playlist's main path plays: the ones a level re-encodes. */
  readonly clips: ReadonlyMap<string, ClipInfo>;
  /** The largest of them: its video decides the disc's levels, rates and capacity. */
  readonly main: ClipInfo | null;
  readonly audioBps: Map<number, Promise<number>>;
  readonly scans: Map<string, Promise<boolean>>;
}

interface ClipVersion {
  readonly info: ClipInfo;
  readonly runPlan: ClipRunPlan;
  readonly sizeBytes: number;
}

interface Version {
  readonly key: string;
  readonly disc: DiscInfo;
  readonly codec: EncoderCodec;
  readonly fps: number;
  readonly manifest: DiscManifest;
  readonly sizes: ReadonlyMap<string, number>;
  /** CLPI and MPLS files rewritten for the level. */
  readonly rewritten: ReadonlyMap<string, Uint8Array>;
  /** By `.M2TS` path. */
  readonly clips: ReadonlyMap<string, ClipVersion>;
}

/** CLPI video_format code → lines (libbluray bd_video_format_e). */
const FORMAT_LINES: Readonly<Record<number, number>> = { 1: 480, 2: 576, 3: 480, 4: 1080, 5: 720, 6: 1080, 7: 576, 8: 2160 };
/** CLPI frame-rate code → frames per second (an interlaced source is deinterlaced to its frame rate). */
const RATE_FPS: Readonly<Record<number, number>> = { 1: 24_000 / 1001, 2: 24, 3: 25, 4: 30_000 / 1001, 6: 50, 7: 60_000 / 1001 };
const GRAPHICS_CODINGS = new Set<number>([CodingType.PG, CodingType.IG, CodingType.TEXT_SUBTITLE]);

class Lru<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly max: number) {}
  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    for (const oldest of this.map.keys()) {
      if (this.map.size <= this.max) break;
      this.map.delete(oldest);
    }
  }
  delete(key: string, value: V): void {
    if (this.map.get(key) === value) this.map.delete(key);
  }
}

function isTimeout(signal: AbortSignal, reason: unknown): boolean {
  return signal.aborted && signal.reason === reason;
}

/**
 * Serves discs at re-encoded quality levels (spec §5–§6): each level is another version of the disc, with the same
 * files, its stream files re-encoded and the CLPI and MPLS files that describe them rewritten. Reads of a level's stream
 * files drive one encoder per clip (`ClipRunner`), ahead of the reader; finished intervals live in the segment cache.
 * Every viewing holds a lease on the GPU's capacity.
 */
export class LevelService {
  private readonly discInfos = new Lru<Promise<DiscInfo>>(DISC_INFOS);
  private readonly versions = new Lru<Promise<Version | null>>(VERSIONS);
  private readonly runners = new Map<string, ClipRunner>();
  private readonly clock: Clock;
  private readonly log: (message: string) => void;

  constructor(private readonly options: LevelServiceOptions) {
    this.clock = options.clock ?? realClock;
    this.log = options.log ?? (() => {});
  }

  /**
   * The disc's manifest at a level and audio stream (1-based, as PSR1), and a lease for the viewing; `busy` when the GPU
   * has no room for it, null when the disc is gone or isn't offered at that level.
   */
  async manifest(discId: string, level: string, audio: number, viewingId: string): Promise<DiscManifest | { busy: true } | null> {
    if (!(await this.options.discs(discId))) return null;
    const version = await this.version(discId, level, audio);
    if (!version) return null;
    if (!this.admit(version, viewingId)) return { busy: true };
    return version.manifest;
  }

  /**
   * Bytes [offset, offset + length) of a file of the disc at a level. A stream file's bytes come from the cache, or the
   * read waits on the clip's encoder (restarted at the interval when it is not about to reach it); after 15 s of waiting
   * the answer is `retryAfter`. `busy` when the viewing holds no lease and none is free; null when the disc or file is
   * gone. Throws a RangeError when the range runs past the file.
   */
  async read(
    discId: string,
    level: string,
    audio: number,
    path: string,
    offset: number,
    length: number,
    viewingId: string,
    signal: AbortSignal,
  ): Promise<Buffer | { retryAfter: 1 } | { busy: true } | null> {
    const version = await this.version(discId, level, audio);
    if (!version) return null;
    const key = path.toUpperCase();
    const size = version.sizes.get(key);
    if (size === undefined) return null;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > size) {
      throw new RangeError(`levels: bytes ${offset}+${length} lie past ${key} (${size} bytes)`);
    }
    if (!this.admit(version, viewingId)) return { busy: true };
    const rewritten = version.rewritten.get(key);
    if (rewritten) return Buffer.from(rewritten.subarray(offset, offset + length));
    const clip = version.clips.get(key);
    if (!clip) return version.disc.source.readRange(key, offset, length);
    if (length === 0) return Buffer.alloc(0);
    return this.readClip(version, clip, viewingId, offset, length, signal);
  }

  /** The levels a disc can be played at, for a client that decodes what `client` says. */
  async levels(discId: string, client: { readonly hevc: boolean; readonly hevc10: boolean; readonly hdr: boolean }): Promise<LevelInfo[] | null> {
    const source = await this.options.discs(discId);
    if (!source) return null;
    const disc = await this.discInfo(discId, source);
    const main = disc.main;
    if (!main) return [{ level: 'original', label: LABELS.original, budgetMbps: 0, available: true }];
    const offered = levelsFor(main.video);
    const durationS = filmSeconds(planClip(main.clpi, levelDefFor('phone-720', main.video), 0).intervals);
    const mbps = (bytes: number): number => Math.round((bytes * 8) / durationS / 100_000) / 10;
    const out: LevelInfo[] = [];
    const originalSize = disc.sizes.get(main.m2tsPath) ?? 0;
    out.push({
      level: 'original',
      label: LABELS.original,
      budgetMbps: mbps(originalSize),
      ...(offered.includes('original') ? { available: true } : { available: false, reason: 'unplayable' as const }),
    });
    const audio = keptAudioFor(main.item, 1);
    const audioBps = audio ? await this.audioBps(disc, main, audio) : 0;
    const fps = RATE_FPS[main.video.rate] ?? RATE_FPS[4]!;
    for (const level of offered) {
      if (level === 'original') continue;
      const def = levelDefFor(level, main.video);
      const reason: LevelReason | undefined =
        def.codec === 'hevc' && !client.hevc
          ? 'no-hevc'
          : def.hdr && !client.hevc10
            ? 'no-hevc10'
            : def.hdr && !client.hdr
              ? 'no-hdr-display'
              : !this.options.capacity.fits(def.codec, fps)
                ? 'busy'
                : undefined;
      const budget = mbps(planClip(main.clpi, def, audioBps).sizeBytes);
      out.push({ level, label: LABELS[level], budgetMbps: budget, ...(reason ? { available: false, reason } : { available: true }) });
    }
    return out;
  }

  /** Stops every encoder. */
  close(): void {
    for (const runner of this.runners.values()) runner.close();
    this.runners.clear();
  }

  private admit(version: Version, viewingId: string): boolean {
    const { capacity } = this.options;
    if (capacity.has(viewingId)) {
      capacity.touch(viewingId);
      return true;
    }
    const viewer = viewerOf(viewingId);
    const replacing = viewer ? capacity.inUse().viewings.filter((v) => v.viewingId.startsWith(viewer)).map((v) => v.viewingId) : [];
    return capacity.lease(viewingId, version.codec, version.fps, replacing);
  }

  private async readClip(version: Version, clip: ClipVersion, viewingId: string, offset: number, length: number, signal: AbortSignal): Promise<Buffer | { retryAfter: 1 }> {
    const runner = this.runner(version, clip, viewingId);
    const { intervals } = clip.runPlan;
    const first = intervalAt(intervals, offset);
    const last = intervalAt(intervals, offset + length - 1);
    runner.noteRead(first);

    const timeout = new Error('levels: the read waited too long');
    const wait = new AbortController();
    const timer = this.clock.setTimeout(() => wait.abort(timeout), this.options.waitMs ?? READ_WAIT_MS);
    const onAbort = (): void => wait.abort(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    try {
      const out = Buffer.allocUnsafe(length);
      for (let i = first; i <= last; i++) {
        const iv = intervals[i]!;
        const bytes = await runner.interval(i, wait.signal);
        const start = iv.spnStart * SOURCE_PACKET_BYTES;
        const from = Math.max(offset, start);
        const to = Math.min(offset + length, start + iv.budgetBytes);
        if (bytes.length !== iv.budgetBytes) throw new Error(`levels: interval ${i} is ${bytes.length} bytes, not its budget of ${iv.budgetBytes}`);
        bytes.copy(out, from - offset, from - start, to - start);
      }
      return out;
    } catch (err) {
      if (isTimeout(wait.signal, timeout) && !signal.aborted) return { retryAfter: 1 };
      throw err;
    } finally {
      this.clock.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * The viewing's encoder for a clip. Each viewing has its own (its lease pays for it), so two viewers far apart in one
   * clip never restart each other's; they share the cache.
   */
  private runner(version: Version, clip: ClipVersion, viewingId: string): ClipRunner {
    const key = `${viewingId}|${version.key}|${clip.info.id}`;
    let runner = this.runners.get(key);
    if (!runner) {
      const created: ClipRunner = new ClipRunner(clip.runPlan, {
        backend: this.options.backend,
        cache: this.options.cache,
        clock: this.clock,
        readAheadMs: this.options.readAheadMs ?? READ_AHEAD_FILM_MS,
        idleMs: this.options.idleMs ?? ENCODER_IDLE_MS,
        onIdle: () => {
          if (this.runners.get(key) === created) this.runners.delete(key);
        },
        log: this.log,
      });
      runner = created;
      this.runners.set(key, runner);
    }
    return runner;
  }

  private version(discId: string, level: string, audio: number): Promise<Version | null> {
    if (!ENCODED_LEVELS.has(level) || !Number.isInteger(audio) || audio < 1 || audio > 32) return Promise.resolve(null);
    const key = `${discId}:${level}:${audio}`;
    let version = this.versions.get(key);
    if (!version) {
      const built = this.buildVersion(key, discId, level as EncodedLevel, audio);
      version = built;
      this.versions.set(key, built);
      built.then(
        (v) => {
          if (!v) this.versions.delete(key, built);
        },
        () => this.versions.delete(key, built),
      );
    }
    return version;
  }

  private async buildVersion(key: string, discId: string, level: EncodedLevel, audio: number): Promise<Version | null> {
    const source = await this.options.discs(discId);
    if (!source) return null;
    const disc = await this.discInfo(discId, source);
    const main = disc.main;
    if (!main || !levelsFor(main.video).includes(level)) return null;

    const rewritten = new Map<string, Uint8Array>();
    const clips = new Map<string, ClipVersion>();
    const defs = new Map<string, LevelDef>();
    for (const info of disc.clips.values()) {
      const clipSource = await source.clip(info.m2tsPath);
      if (!clipSource) continue;
      const def = levelDefFor(level, info.video);
      defs.set(info.id, def);
      const kept = keptAudioFor(info.item, audio);
      const audioBps = kept ? await this.audioBps(disc, info, kept) : 0;
      const { intervals, sizeBytes } = planClip(info.clpi, def, audioBps);
      const streams = info.clpi.programs.flatMap((p) => p.streams);
      const graphics = [...new Set(streams.filter((s) => GRAPHICS_CODINGS.has(s.codingType)).map((s) => s.pid))];
      rewritten.set(
        info.clpiPath,
        rewriteClpi(info.clpiBytes, { intervals, level: def, keepPids: graphics, audio: kept, videoPid: info.video.pid, ...videoAttrsFor(def, info.video.rate) }),
      );
      clips.set(info.m2tsPath, { info, sizeBytes, runPlan: this.runPlan(disc, info, def, kept, graphics, intervals, clipSource, level, audio) });
    }
    if (clips.size === 0) return null;
    for (const playlist of disc.playlists) {
      const clipId = playlist.clipIds.find((id) => defs.has(id));
      if (clipId === undefined) continue; // no clip with video: unchanged
      const info = disc.clips.get(clipId)!;
      rewritten.set(playlist.path, rewriteMpls(playlist.bytes, { audioStreamNumber: audio }, videoAttrsFor(defs.get(clipId)!, info.video.rate)));
    }

    const sizes = new Map(disc.sizes);
    for (const [path, clip] of clips) sizes.set(path, clip.sizeBytes);
    for (const [path, bytes] of rewritten) sizes.set(path, bytes.length);
    const inline: Record<string, string> = { ...disc.manifest.inline };
    for (const [path, bytes] of rewritten) if (path in inline) inline[path] = Buffer.from(bytes).toString('base64');
    const manifest: DiscManifest = {
      ...disc.manifest,
      files: disc.manifest.files.map((f) => ({ path: f.path, size: sizes.get(f.path) ?? f.size })),
      inline,
    };
    return {
      key,
      disc,
      codec: defs.get(main.id)?.codec ?? levelDefFor(level, main.video).codec,
      fps: RATE_FPS[main.video.rate] ?? RATE_FPS[4]!,
      manifest,
      sizes,
      rewritten,
      clips,
    };
  }

  private runPlan(
    disc: DiscInfo,
    info: ClipInfo,
    def: LevelDef,
    kept: KeptAudio | null,
    graphics: readonly number[],
    intervals: readonly IntervalPlan[],
    clipSource: ClipSource,
    level: EncodedLevel,
    audio: number,
  ): ClipRunPlan {
    const { clpi, video } = info;
    const stcs = clpi.atcSequences.flatMap((a) => a.stc);
    const stcStarts = stcs.map((s) => s.spnStcStart);
    const pcrPid = stcs[0]?.pcrPid ?? video.pid;
    const ownPcrPids = [...new Set(stcs.map((s) => s.pcrPid))].filter((pid) => pid !== video.pid);
    const keepPids = [0, ...graphics, ...ownPcrPids, ...(kept ? [kept.pid] : [])];
    const coreFilters = new Map<number, number>();
    if (kept && kept.coding !== coreCoding(kept.coding)) coreFilters.set(kept.pid, kept.coding);
    const firstEp = videoEpMap(clpi)!.entries[0]!;
    return {
      intervals,
      cacheKey: this.options.cache.key(disc.id, level, audio, info.id, clipSource.size, clipSource.mtimeMs),
      read: clipSource.read,
      encoder: {
        input: clipSource.input,
        intervals,
        stcStarts,
        videoPid: video.pid,
        sourceCoding: video.codingType,
        level: def,
        hdr: video.hdr,
        ...(this.options.spawn ? { spawn: this.options.spawn } : {}),
      },
      interlaced: () => this.interlaced(disc, info, clipSource, firstEp.spn * SOURCE_PACKET_BYTES),
      kept: {
        keepPids,
        coreFilters,
        pmtPids: [...new Set(clpi.programs.map((p) => p.programMapPid))],
        videoStreamType: def.codec === 'h264' ? CodingType.AVC : CodingType.HEVC,
        pcrPid,
      },
    };
  }

  /** Whether a clip is deinterlaced: one scan probe per clip (ruling L-R6), a failed one tried again next time. */
  private interlaced(disc: DiscInfo, info: ClipInfo, clipSource: ClipSource, startByte: number): Promise<boolean> {
    let scan = disc.scans.get(info.id);
    if (!scan) {
      const probe = this.options.probe ?? ((input, options) => probeScan(input, { ...options, ...(this.options.spawn ? { spawn: this.options.spawn } : {}) }));
      const probing = probe(clipSource.input, { startByte, videoPid: info.video.pid }).then(deinterlaces);
      scan = probing;
      disc.scans.set(info.id, probing);
      probing.catch(() => {
        if (disc.scans.get(info.id) === probing) disc.scans.delete(info.id);
      });
    }
    return scan;
  }

  /** The kept audio's nominal rate, from its first frame in the clip (spec §5.2). */
  private audioBps(disc: DiscInfo, info: ClipInfo, kept: KeptAudio): Promise<number> {
    let bps = disc.audioBps.get(kept.pid);
    if (!bps) {
      const reading = (async () => {
        const clip = await disc.source.clip(info.m2tsPath);
        if (!clip) throw new Error(`levels: ${info.m2tsPath} is missing`);
        return firstAudioBps(clip.read(0, Math.min(clip.size, AUDIO_PROBE_BYTES)), kept.pid, kept.coding);
      })();
      bps = reading;
      disc.audioBps.set(kept.pid, reading);
      reading.catch(() => {
        if (disc.audioBps.get(kept.pid) === reading) disc.audioBps.delete(kept.pid);
      });
    }
    return bps;
  }

  private discInfo(discId: string, source: LevelDiscSource): Promise<DiscInfo> {
    let info = this.discInfos.get(discId);
    if (!info) {
      const loading = loadDisc(discId, source);
      info = loading;
      this.discInfos.set(discId, loading);
      loading.catch(() => this.discInfos.delete(discId, loading));
    }
    return info;
  }
}

/** The interval holding byte `offset` of a level's clip. */
function intervalAt(intervals: readonly IntervalPlan[], offset: number): number {
  const spn = Math.floor(offset / SOURCE_PACKET_BYTES);
  let lo = 0;
  let hi = intervals.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (intervals[mid]!.spnStart <= spn) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function filmSeconds(intervals: readonly IntervalPlan[]): number {
  return Math.max(1, intervals.reduce((n, iv) => n + iv.endPts45 - iv.startPts45, 0)) / 45_000;
}

async function fileBytes(disc: { manifest: DiscManifest; source: LevelDiscSource }, path: string): Promise<Uint8Array | null> {
  const inline = disc.manifest.inline[path];
  if (inline !== undefined) return new Uint8Array(Buffer.from(inline, 'base64'));
  return disc.source.readFile(path);
}

/** Reads a disc's playlists and clip information, and finds the clips a level re-encodes. */
async function loadDisc(id: string, source: LevelDiscSource): Promise<DiscInfo> {
  const manifest = await source.manifest();
  const sizes = new Map(manifest.files.map((f) => [f.path, f.size]));
  const playlists: DiscInfo['playlists'][number][] = [];
  const items = new Map<string, PlayItem>();
  for (const { path } of manifest.files) {
    if (!/^BDMV\/PLAYLIST\/[^/]+\.MPLS$/.test(path)) continue;
    const bytes = await fileBytes({ manifest, source }, path);
    let mpls: Mpls;
    try {
      if (!bytes) continue;
      mpls = parseMpls(bytes);
    } catch {
      continue; // a playlist the player can't read either
    }
    const clipIds: string[] = [];
    for (const item of mpls.playItems) {
      for (const clipId of [item.clipId, ...item.angleClipIds]) {
        clipIds.push(clipId);
        if (!items.has(clipId)) items.set(clipId, item);
      }
    }
    playlists.push({ path, bytes: bytes!, clipIds });
  }

  const clips = new Map<string, ClipInfo>();
  for (const [clipId, item] of items) {
    const clpiPath = `BDMV/CLIPINF/${clipId}.CLPI`;
    const m2tsPath = `BDMV/STREAM/${clipId}.M2TS`;
    if (!sizes.has(m2tsPath)) continue;
    const clpiBytes = await fileBytes({ manifest, source }, clpiPath);
    if (!clpiBytes) continue;
    let clpi: Clpi;
    try {
      clpi = parseClpi(clpiBytes);
    } catch {
      continue;
    }
    const map = videoEpMap(clpi);
    if (!map || map.entries.length === 0) continue;
    const stream = clpi.programs.flatMap((p) => p.streams).find((s) => s.pid === map.pid)!;
    const height = FORMAT_LINES[stream.format] ?? 1080;
    // UHD discs carry HDR10 (the CLPI's dynamic range field isn't parsed): an HEVC 2160-line source is taken as HDR.
    const hdr = stream.codingType === CodingType.HEVC && height >= 2160;
    clips.set(clipId, { id: clipId, clpiPath, m2tsPath, clpiBytes, clpi, video: { pid: map.pid, codingType: stream.codingType, height, rate: stream.rate, hdr }, item });
  }
  let main: ClipInfo | null = null;
  for (const c of clips.values()) if (!main || (sizes.get(c.m2tsPath) ?? 0) > (sizes.get(main.m2tsPath) ?? 0)) main = c;
  return { id, source, manifest, sizes, playlists, clips, main, audioBps: new Map(), scans: new Map() };
}

/**
 * The nominal rate of an audio PID's first readable frame in `stream` (the head of a clip): its PES packets are
 * gathered in order, reduced to the core a level carries, and the first one `nominalAudioBps` reads decides.
 */
export async function firstAudioBps(stream: Readable, pid: number, coding: number): Promise<number> {
  const filter = new PesCoreFilter(coding);
  let chunks: Uint8Array[] = [];
  let partial = new Uint8Array(0);
  let lastError: Error | null = null;
  const tryPes = (): number | null => {
    if (chunks.length === 0) return null;
    const size = chunks.reduce((n, c) => n + c.length, 0);
    let pes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      pes.set(c, at);
      at += c.length;
    }
    chunks = [];
    const declared = pes.length >= 6 ? (pes[4]! << 8) | pes[5]! : 0;
    if (declared) pes = pes.subarray(0, 6 + declared);
    const core = pes.length >= 9 ? filter.push(pes) : null;
    if (!core) return null;
    try {
      return nominalAudioBps(coding, core.subarray(9 + core[8]!));
    } catch (err) {
      lastError = err as Error;
      return null;
    }
  };
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      let data = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      if (partial.length) {
        const joined = new Uint8Array(partial.length + data.length);
        joined.set(partial);
        joined.set(data, partial.length);
        data = joined;
      }
      const whole = data.length - (data.length % SOURCE_PACKET_BYTES);
      for (let p = 0; p < whole; p += SOURCE_PACKET_BYTES) {
        if (data[p + 4] !== 0x47 || (((data[p + 5]! & 0x1f) << 8) | data[p + 6]!) !== pid) continue;
        const flags = data[p + 7]!;
        if (!(flags & 0x10)) continue;
        const payloadAt = flags & 0x20 ? p + 9 + data[p + 8]! : p + 8;
        if (payloadAt >= p + SOURCE_PACKET_BYTES) continue;
        if (data[p + 5]! & 0x40) {
          const bps = tryPes();
          if (bps !== null) return bps;
        }
        chunks.push(data.slice(payloadAt, p + SOURCE_PACKET_BYTES));
      }
      partial = data.slice(whole);
    }
    const bps = tryPes();
    if (bps !== null) return bps;
  } finally {
    stream.destroy();
  }
  throw lastError ?? new Error(`levels: no audio frame of PID 0x${pid.toString(16)} at the clip's start`);
}

/** Collects a stream into one buffer. */
async function collect(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) parts.push(chunk);
  return Buffer.concat(parts);
}

/** A folder disc's files for the level service. */
export function folderDiscSource(dir: string, disc: { id: string; name: string }): LevelDiscSource {
  return {
    manifest: () => buildManifest(dir, disc),
    async readFile(path) {
      const abs = await resolveDiscFile(dir, path);
      return abs ? new Uint8Array(await readFile(abs)) : null;
    },
    async readRange(path, offset, length) {
      const abs = await resolveDiscFile(dir, path);
      if (!abs) return null;
      const handle = await open(abs, 'r');
      try {
        const out = Buffer.alloc(length);
        let got = 0;
        while (got < length) {
          const { bytesRead } = await handle.read(out, got, length - got, offset + got);
          if (bytesRead === 0) throw new Error(`levels: ${path} is shorter than its manifest says`);
          got += bytesRead;
        }
        return out;
      } finally {
        await handle.close();
      }
    },
    async clip(path) {
      const abs = await resolveDiscFile(dir, path);
      if (!abs) return null;
      const st = await stat(abs);
      return {
        input: { path: abs },
        read: (from, to) => createReadStream(abs, { start: from, ...(to === undefined ? {} : { end: to - 1 }) }),
        size: st.size,
        mtimeMs: st.mtimeMs,
      };
    },
  };
}

/** An ISO disc's files for the level service: ffmpeg gets a stream file's bytes through a pipe. */
export function isoDiscSource(abs: string, tree: ReadonlyMap<string, UdfFile>, disc: { id: string; name: string }): LevelDiscSource {
  const file = (path: string): UdfFile | null => resolveIsoFile(tree, path);
  return {
    manifest: () => buildIsoManifest(abs, tree, disc),
    async readFile(path) {
      const f = file(path);
      if (!f) return null;
      const got = (await readIsoFiles(abs, [f])).get(f.path);
      return got ? new Uint8Array(got) : null;
    },
    async readRange(path, offset, length) {
      const f = file(path);
      if (!f) return null;
      if (length === 0) return Buffer.alloc(0);
      return collect(isoFileStream(abs, f, offset, offset + length - 1));
    },
    async clip(path) {
      const f = file(path);
      if (!f) return null;
      const { mtimeMs } = await stat(abs);
      const read: ClipReader = (from, to) => isoFileStream(abs, f, from, (to ?? f.size) - 1);
      return { input: { read }, read, size: f.size, mtimeMs };
    },
  };
}

/** The library's discs for the level service: a disc that is gone or changed since the scan is null. */
export function libraryDiscSources(library: Library, isoTrees: IsoTrees = new IsoTrees()): (discId: string) => Promise<LevelDiscSource | null> {
  return async (discId) => {
    const disc: DiscEntry | null = library.disc(discId);
    if (!disc) return null;
    const abs = library.locate(disc);
    if (!abs) return null;
    if (disc.kind === 'iso') {
      if (!(await isoUnchanged(disc, abs))) return null;
      return isoDiscSource(abs, await isoTrees.get(disc.id, abs), disc);
    }
    if (!(await discUnchanged(disc, abs))) return null;
    return folderDiscSource(abs, disc);
  };
}
