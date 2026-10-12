import { CodingType } from '../../src/engine/bdmv/stream-types';
import { FileSource } from '../../src/engine/disc/file-source';
import { normalizeDiscPaths } from '../../src/engine/disc/paths';
import { buildClpi, buildIndex, buildMpls, type MarkSpec } from './bdmv-builders';
import { avcAu } from './h264-units';
import { muxM2ts, type MuxUnit } from './ts-muxer';

export const VIDEO_PID = 0x1011;
export const AUDIO_PID = 0x1100;
/** 24 fps in 90 kHz ticks. */
export const FRAME_TICKS_90K = 3750;
/** 5 ms of 48 kHz audio per LPCM PES (450 ticks at 90 kHz). */
export const AUDIO_FRAMES_PER_PES = 240;
const AUDIO_PES_TICKS_90K = 450;
export const CLIP_START_PTS = 900_000;

export interface SyntheticClipSpec {
  clipId: string;
  /** Video access units in decode order, no B-frames, one per frame at 24 fps. */
  videoAus: Uint8Array[];
  /** Indices of IDR units; they become EP-map entries. */
  keyIndices: number[];
  /** 90 kHz PTS of the first frame (even). */
  startPts: number;
  /** Audio coding type: LPCM gets a real 440 Hz tone, other types get dummy payloads. Omit for no audio. */
  audio?: number;
  /** Index of one LPCM PES whose header gets a reserved sample-rate code (a corrupt unit). */
  corruptAudioPesIndex?: number;
}

export interface SyntheticPlaylistSpec {
  id: string;
  clipIds: string[];
  /** Video coding type declared in the STN table (default AVC). */
  videoCodingType?: number;
  chapterEverySeconds?: number;
}

export interface SyntheticDiscSpec {
  clips: SyntheticClipSpec[];
  playlists: SyntheticPlaylistSpec[];
}

/** One LPCM PES payload: 48 kHz, 16-bit stereo, 440 Hz at −12 dBFS. */
export function lpcmPayload(frames: number, startFrame: number): Uint8Array {
  const out = new Uint8Array(4 + frames * 4);
  const size = frames * 4;
  out[0] = size >> 8;
  out[1] = size & 0xff;
  out[2] = 0x31; // stereo, 48 kHz
  out[3] = 0x40; // 16-bit
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * (startFrame + i)) / 48_000) * 8192) & 0xffff;
    const o = 4 + i * 4;
    out[o] = v >> 8;
    out[o + 1] = v & 0xff;
    out[o + 2] = v >> 8;
    out[o + 3] = v & 0xff;
  }
  return out;
}

/** A clip of fake AVC units (IDR every `keyEvery` frames), optionally with audio. */
export function syntheticClip(clipId: string, seconds: number, opts: { audio?: number; keyEvery?: number; startPts?: number; corruptAudioPesIndex?: number } = {}): SyntheticClipSpec {
  const keyEvery = opts.keyEvery ?? 24;
  const frames = seconds * 24;
  const videoAus: Uint8Array[] = [];
  const keyIndices: number[] = [];
  for (let i = 0; i < frames; i++) {
    const idr = i % keyEvery === 0;
    if (idr) keyIndices.push(i);
    videoAus.push(avcAu({ idr, fill: 300 }));
  }
  return { clipId, videoAus, keyIndices, startPts: opts.startPts ?? CLIP_START_PTS, audio: opts.audio, corruptAudioPesIndex: opts.corruptAudioPesIndex };
}

export function buildSyntheticDisc(spec: SyntheticDiscSpec): Map<string, Uint8Array<ArrayBuffer>> {
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  files.set('BDMV/index.bdmv', buildIndex({ firstPlay: { kind: 'hdmv', movieObjectId: 0 }, topMenu: { kind: 'hdmv', movieObjectId: 1 }, titles: [{ kind: 'hdmv', movieObjectId: 2 }] }));
  const clips = new Map<string, { inTime: number; outTime: number; audio?: number }>();

  for (const clip of spec.clips) {
    const endPts = clip.startPts + clip.videoAus.length * FRAME_TICKS_90K;
    const units: Array<MuxUnit & { videoIndex?: number }> = clip.videoAus.map((payload, i) => ({
      pid: VIDEO_PID,
      streamId: 0xe0,
      pts: clip.startPts + i * FRAME_TICKS_90K,
      payload,
      videoIndex: i,
    }));
    if (clip.audio !== undefined) {
      const count = Math.ceil((endPts - clip.startPts) / AUDIO_PES_TICKS_90K);
      for (let j = 0; j < count; j++) {
        const payload = clip.audio === CodingType.LPCM ? lpcmPayload(AUDIO_FRAMES_PER_PES, j * AUDIO_FRAMES_PER_PES) : new Uint8Array(64).fill(0x0b);
        if (j === clip.corruptAudioPesIndex && payload.length > 2) payload[2] = 0x30; // reserved sample-rate code
        units.push({ pid: AUDIO_PID, streamId: 0xbd, pts: clip.startPts + j * AUDIO_PES_TICKS_90K, payload });
      }
    }
    units.sort((a, b) => a.pts - b.pts || (a.pid === AUDIO_PID ? -1 : 1));
    const { bytes, unitSpns } = muxM2ts(units);
    const keySet = new Set(clip.keyIndices);
    const entries = units.flatMap((u, i) =>
      u.videoIndex !== undefined && keySet.has(u.videoIndex) ? [{ pts: Math.floor(u.pts / 2), spn: unitSpns[i] }] : [],
    );
    const streams: Array<{ pid: number; codingType: number }> = [{ pid: VIDEO_PID, codingType: CodingType.AVC }];
    if (clip.audio !== undefined) streams.push({ pid: AUDIO_PID, codingType: clip.audio });
    files.set(`BDMV/STREAM/${clip.clipId}.m2ts`, bytes);
    files.set(
      `BDMV/CLIPINF/${clip.clipId}.clpi`,
      buildClpi({ numSourcePackets: bytes.length / 192, streams, presentationStart: clip.startPts / 2, presentationEnd: endPts / 2, epMaps: [{ pid: VIDEO_PID, entries }] }),
    );
    clips.set(clip.clipId, { inTime: clip.startPts / 2, outTime: endPts / 2, audio: clip.audio });
  }

  for (const playlist of spec.playlists) {
    const marks: MarkSpec[] = [];
    const playItems = playlist.clipIds.map((clipId, index) => {
      const clip = clips.get(clipId);
      if (!clip) throw new Error(`unknown clip ${clipId}`);
      const step = (playlist.chapterEverySeconds ?? 0) * 45_000;
      if (step > 0) for (let t = clip.inTime; t < clip.outTime; t += step) marks.push({ playItemRef: index, time: t });
      return {
        clipId,
        inTime: clip.inTime,
        outTime: clip.outTime,
        connectionCondition: index === 0 ? 1 : 5,
        video: [{ pid: VIDEO_PID, codingType: playlist.videoCodingType ?? CodingType.AVC }],
        audio: clip.audio === undefined ? [] : [{ pid: AUDIO_PID, codingType: clip.audio }],
      };
    });
    files.set(`BDMV/PLAYLIST/${playlist.id}.mpls`, buildMpls({ playItems, marks }));
  }
  return files;
}

export function discEntries(files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>, root = 'Disc'): Array<[string, File]> {
  return [...files].map(([path, bytes]) => [`${root}/${path}`, new File([bytes], path.split('/').pop() ?? path)]);
}

export function syntheticSource(files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>): FileSource {
  return new FileSource(normalizeDiscPaths(discEntries(files)));
}
