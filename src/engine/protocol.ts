import type { ClockMode } from './clock/master-clock';
import type { DiscErrorCode } from './disc/byte-source';
import type { PlaylistSummary } from './disc/open-disc';
import type { Chapter } from './nav/timeline';

export type PlaybackState = 'idle' | 'loading' | 'paused' | 'buffering' | 'playing' | 'ended' | 'error';
export type NoticeCode = 'bdj' | 'audio-disabled' | 'decoder-recovered';
export type ErrorCode = DiscErrorCode | 'corrupt-disc' | 'decoder-failed' | 'no-video' | 'internal';

export interface Telemetry {
  readonly clockUs: number;
  readonly clockMode: ClockMode;
  /** Mean of (clock − frame timestamp) for frames first drawn in this window while playing. */
  readonly avOffsetMeanUs: number | null;
  readonly avOffsetMaxAbsUs: number | null;
  readonly framesInWindow: number;
  readonly framesPresented: number;
  readonly framesDropped: number;
  readonly audioBufferedMs: number;
  readonly audioUnderruns: number;
  readonly corruptPackets: number;
  /** Coding name of the stream whose decoder last produced PCM, or null before any. */
  readonly audioCodec: string | null;
  readonly audioDecodeErrors: number;
  readonly continuityErrors: number;
  readonly decoderErrors: number;
  /** Decoding restarts on an open-GOP (non-IDR) keyframe in this session, and leading pictures skipped after them. */
  readonly openGopStarts: number;
  readonly leadingPicturesSkipped: number;
}

export type EngineCommand =
  | { readonly type: 'open'; readonly entries: ReadonlyArray<readonly [string, Blob]> }
  | { readonly type: 'attachCanvas'; readonly canvas: OffscreenCanvas }
  | { readonly type: 'attachAudio'; readonly ring: SharedArrayBuffer }
  | { readonly type: 'resize'; readonly width: number; readonly height: number }
  | { readonly type: 'playPlaylist'; readonly playlistId: string }
  | { readonly type: 'play' }
  | { readonly type: 'pause' }
  | { readonly type: 'seek'; readonly timeUs: number }
  | { readonly type: 'nextChapter' }
  | { readonly type: 'prevChapter' }
  /** Forget the open disc ("Open another disc"). */
  | { readonly type: 'close' };

export type EngineEvent =
  | { readonly type: 'titles'; readonly playlists: readonly PlaylistSummary[]; readonly usesBdj: boolean; readonly warnings: readonly string[] }
  | { readonly type: 'chapters'; readonly playlistId: string; readonly durationUs: number; readonly chapters: readonly Chapter[] }
  | { readonly type: 'state'; readonly state: PlaybackState }
  | { readonly type: 'time'; readonly timeUs: number }
  | { readonly type: 'notice'; readonly code: NoticeCode; readonly message: string }
  | { readonly type: 'unsupported'; readonly kind: 'video' | 'audio'; readonly codec: string; readonly message: string }
  | { readonly type: 'error'; readonly code: ErrorCode; readonly message: string; readonly paths: readonly string[] }
  | { readonly type: 'telemetry'; readonly telemetry: Telemetry }
  /** The current playlist was torn down (a new pick, a failed pick, or close). */
  | { readonly type: 'playlistCleared' };
