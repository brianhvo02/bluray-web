import type { ClockMode } from './clock/master-clock';
import type { DiscErrorCode } from './disc/byte-source';
import type { PlaylistSummary } from './disc/open-disc';
import type { UoOp } from './hdmv/uo-mask';
import type { Chapter } from './nav/timeline';

export type PlaybackState = 'idle' | 'loading' | 'paused' | 'buffering' | 'playing' | 'ended' | 'error';
export type NoticeCode = 'bdj' | 'audio-disabled' | 'decoder-recovered' | 'uo-masked' | 'subtitle-file';
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
  /** Interactive menu state (PSR11, PSR10, draw operations in the last repaint of the IG plane), or null while no menu is open. */
  readonly menu: { readonly page: number; readonly selectedButton: number; readonly buttonsDrawn: number } | null;
  /** Corrupt IG segments dropped. */
  readonly igErrors: number;
  /** Menu sound effects asked for since the disc opened. */
  readonly soundsPlayed: number;
  /** The last PG display set shown: composition objects drawn and how many of them were forced; null before any (and after a reset). */
  readonly pg: { readonly objectsShown: number; readonly forced: number } | null;
  /** Corrupt PG segments dropped. */
  readonly pgErrors: number;
  /** A text subtitle cue is on screen. */
  readonly textCue: boolean;
}

export interface PgTrack {
  /** PG stream number (PSR2), 1-based. */
  readonly index: number;
  /** ISO 639-2 code from the STN, or ''. */
  readonly language: string;
}

export type SubtitleChoice = { readonly kind: 'pg'; readonly stream: number } | { readonly kind: 'text' } | { readonly kind: 'off' };

export type ChannelsLabel = 'mono' | 'stereo' | 'multichannel' | '';

export interface AudioTrack {
  /** 1-based position in the STN audio list. */
  readonly index: number;
  readonly codec: string;
  /** ISO 639-2 code from the STN, or '' if absent. */
  readonly language: string;
  readonly channels: ChannelsLabel;
  readonly playable: boolean;
}

/** Remote-control keys for disc menus (BD_VK_*); topMenu is a menu call. */
export type MenuKey = 'up' | 'down' | 'left' | 'right' | 'ok' | '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'topMenu' | 'popup';

export type EngineCommand =
  | { readonly type: 'open'; readonly entries: ReadonlyArray<readonly [string, Blob]> }
  | { readonly type: 'attachCanvas'; readonly canvas: OffscreenCanvas }
  | { readonly type: 'attachAudio'; readonly ring: SharedArrayBuffer }
  | { readonly type: 'resize'; readonly width: number; readonly height: number }
  | { readonly type: 'playPlaylist'; readonly playlistId: string }
  | { readonly type: 'play' }
  | { readonly type: 'pause' }
  | { readonly type: 'seek'; readonly timeUs: number }
  | { readonly type: 'selectAudio'; readonly index: number }
  | { readonly type: 'selectSubtitle'; readonly choice: SubtitleChoice }
  /** An .srt file; `encoding` (a TextDecoder label) is used when the bytes are neither BOM-marked nor UTF-8. */
  | { readonly type: 'addTextSubtitle'; readonly name: string; readonly bytes: ArrayBuffer; readonly encoding?: string }
  | { readonly type: 'removeTextSubtitle' }
  /** Text subtitle timing shift, clamped to ±10 minutes. */
  | { readonly type: 'setSubtitleOffset'; readonly ms: number }
  /** Text subtitle size factor, clamped to 0.5–2. */
  | { readonly type: 'setSubtitleScale'; readonly scale: number }
  | { readonly type: 'nextChapter' }
  | { readonly type: 'prevChapter' }
  /** HDMV discs only: 0 = top menu. */
  | { readonly type: 'playTitle'; readonly title: number }
  | { readonly type: 'menuCall' }
  | { readonly type: 'menuKey'; readonly key: MenuKey }
  /** In the 1920×1080 menu space. */
  | { readonly type: 'pointer'; readonly kind: 'move' | 'click'; readonly x: number; readonly y: number }
  /** Forget the open disc ("Open another disc"). */
  | { readonly type: 'close' };

export type EngineEvent =
  | { readonly type: 'titles'; readonly playlists: readonly PlaylistSummary[]; readonly usesBdj: boolean; readonly warnings: readonly string[] }
  /** After 'titles', for discs whose First Play is an HDMV object. */
  | { readonly type: 'indexTitles'; readonly titles: ReadonlyArray<{ readonly number: number; readonly kind: 'hdmv' | 'bdj' }>; readonly hasTopMenu: boolean }
  | { readonly type: 'uoMask'; readonly masked: readonly UoOp[] }
  | { readonly type: 'menuActive'; readonly active: boolean; readonly popupAvailable: boolean }
  /** Once after 'titles', for a disc with BDMV/AUXDATA/sound.bdmv: the menu sound clips (48 kHz, interleaved 16-bit). */
  | { readonly type: 'soundEffects'; readonly clips: ReadonlyArray<{ readonly channels: 1 | 2; readonly samples: Int16Array }> }
  /** A menu button asked for a sound clip (an index into soundEffects). */
  | { readonly type: 'soundEffect'; readonly id: number }
  /** After a pointer move: the menu button under the pointer, for the cursor. */
  | { readonly type: 'pointerTarget'; readonly button: number | null }
  | { readonly type: 'chapters'; readonly playlistId: string; readonly durationUs: number; readonly chapters: readonly Chapter[] }
  | { readonly type: 'tracks'; readonly audio: readonly AudioTrack[]; readonly selectedAudio: number | null }
  /** The file is not UTF-8 and no encoding was given: ask the user, then send addTextSubtitle again with one. */
  | { readonly type: 'subtitleEncodingNeeded'; readonly name: string }
  /** On disc open and close, playlist start, a play item whose PG tracks differ, every PSR2 change and every subtitle command. */
  | {
    readonly type: 'subtitles';
    readonly pg: readonly PgTrack[];
    readonly text: { readonly name: string; readonly cues: number } | null;
    readonly selected: 'off' | 'text' | { readonly pg: number };
    readonly offsetMs: number;
    readonly scale: number;
  }
  | { readonly type: 'state'; readonly state: PlaybackState }
  | { readonly type: 'time'; readonly timeUs: number }
  | { readonly type: 'notice'; readonly code: NoticeCode; readonly message: string }
  | { readonly type: 'unsupported'; readonly kind: 'video' | 'audio'; readonly codec: string; readonly message: string }
  | { readonly type: 'error'; readonly code: ErrorCode; readonly message: string; readonly paths: readonly string[] }
  | { readonly type: 'telemetry'; readonly telemetry: Telemetry }
  /** The current playlist was torn down (a new pick, a failed pick, or close). */
  | { readonly type: 'playlistCleared' };
