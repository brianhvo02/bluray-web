import type { MemoryProfileName } from './memory-profile';
import type { ClockMode } from './clock/master-clock';
import type { DiscErrorCode } from './disc/byte-source';
import type { HttpDiscRef } from './disc/http-source';
import type { PlaylistSummary } from './disc/open-disc';
import type { UoOp } from './hdmv/uo-mask';
import type { Chapter } from './nav/timeline';

export type PlaybackState = 'idle' | 'loading' | 'paused' | 'buffering' | 'playing' | 'ended' | 'error';
export type NoticeCode = 'bdj' | 'bdj-tap-ignored' | 'bdj-failed' | 'audio-disabled' | 'decoder-recovered' | 'uo-masked' | 'subtitle-file' | 'subtitle-fonts' | 'menu-memory';
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
  /** Index (name order) of the subtitle set's file showing now, or null. */
  readonly textFile: number | null;
  /** The showing ASS file's last draw (events drawn, how many animate, its time), its draws so far and those over 8 ms; null otherwise. */
  readonly ass: { readonly events: number; readonly animated: number; readonly renderMs: number; readonly overBudget: number; readonly renders: number } | null;
  /** The shader set that shaded the last frame drawn: passes run and GPU time (null without a timer query); null when unshaded. */
  readonly shader: { readonly set: string; readonly passesRun: number; readonly gpuMs: number | null } | null;
  /**
   * BD-J start-up (spec §4.7), in ms since the disc's open command: the worker booted, Java selected its first playlist,
   * the first frame of that playlist was presented. Each is null until it happens; the whole is null when no BD-J title
   * has run since the disc opened.
   */
  readonly bdj: BdjStartup | null;
  /** While a BD-J title runs: its graphics plane's flushes and the taps on its menu that brought no reaction. */
  readonly bdjPlane: { readonly flushes: number; readonly tapsIgnored: number } | null;
}

export interface BdjStartup {
  readonly bootMs: number | null;
  readonly firstPlaylistMs: number | null;
  readonly firstFrameMs: number | null;
}

/** A set of mpv user shaders, in the order they run. */
export interface ShaderSetData { readonly name: string; readonly files: readonly { readonly name: string; readonly source: string }[] }

export type ShaderState = 'off' | 'compiling' | 'active' | 'error' | 'unavailable';

/** A file's name and bytes, transferred with the command. */
export interface FileData { readonly name: string; readonly bytes: ArrayBuffer }

/** One file of the subtitle set, in name order. */
export interface TextFileInfo {
  readonly name: string;
  readonly format: 'srt' | 'ass';
  /** Cues (SRT) or Dialogue events (ASS). */
  readonly cues: number;
  /** Playlist time where the file starts, or null when not placed. */
  readonly startUs: number | null;
  readonly offsetMs: number;
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
  /** Open a disc served over HTTP (tools/disc-server): the engine and BD-J workers each read it with an HttpSource. */
  | { readonly type: 'openRemote'; readonly disc: HttpDiscRef }
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
  /** A subtitle set (SRT and/or ASS files, placed at episode starts) with fonts for its ASS files; replaces the old set. */
  | { readonly type: 'addTextSubtitles'; readonly files: readonly FileData[]; readonly encoding?: string; readonly fonts?: readonly FileData[] }
  /** More fonts for the set's ASS files. */
  | { readonly type: 'addSubtitleFonts'; readonly fonts: readonly FileData[] }
  | { readonly type: 'removeTextSubtitle' }
  /** Places a file of the set (index in name order) at a playlist time, or unplaces it. */
  | { readonly type: 'setSubtitleStart'; readonly file: number; readonly startUs: number | null }
  /** A file's timing shift, clamped to ±10 minutes. */
  | { readonly type: 'setSubtitleOffset'; readonly file: number; readonly ms: number }
  /** Text subtitle size factor, clamped to 0.5–2. */
  | { readonly type: 'setSubtitleScale'; readonly scale: number }
  | { readonly type: 'nextChapter' }
  | { readonly type: 'prevChapter' }
  /** 0 = top menu. */
  | { readonly type: 'playTitle'; readonly title: number }
  | { readonly type: 'menuCall' }
  /** `repeat`: a held key's auto-repeat (KeyboardEvent.repeat), which a BD-J title's full input queue may merge. */
  | { readonly type: 'menuKey'; readonly key: MenuKey; readonly repeat?: boolean }
  /** In the 1920×1080 menu space. Under a BD-J title a move is BDJ_EVENT_MOUSE, a click also the activate key. */
  | { readonly type: 'pointer'; readonly kind: 'move' | 'click'; readonly x: number; readonly y: number }
  /** Forget the open disc ("Open another disc"). */
  | { readonly type: 'close' }
  /** Shade the video with this set (compiled in the background), or draw it unshaded (null). Kept across discs. */
  | { readonly type: 'setVideoShaders'; readonly set: ShaderSetData | null }
  | { readonly type: 'setMemoryProfile'; readonly profile: MemoryProfileName };

export type EngineEvent =
  /** `bdjSupported`: this engine runs BD-J titles. */
  | { readonly type: 'titles'; readonly playlists: readonly PlaylistSummary[]; readonly usesBdj: boolean; readonly bdjSupported: boolean; readonly warnings: readonly string[] }
  /** A BD-J title started (the disc's Java code drives playback and draws its menus) or BD-J stopped. */
  | { readonly type: 'bdjActive'; readonly active: boolean }
  /**
   * The BD-J graphics plane turned visible (any pixel with non-zero alpha) or empty; on changes only, and false when
   * BD-J stops. While it is visible, taps and clicks on the video go to the disc.
   */
  | { readonly type: 'bdjMenu'; readonly visible: boolean }
  /** A tap on a BD-J menu brought no reaction within the window: the UI opens the on-screen remote. */
  | { readonly type: 'bdjTapIgnored' }
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
  /** Files of a load are not UTF-8 and no encoding was given: ask the user, then send addTextSubtitles again with one. */
  | { readonly type: 'subtitleEncodingNeeded'; readonly names: readonly string[] }
  /** On disc open and close, playlist start, a play item whose PG tracks differ, every PSR2 change and every subtitle command. */
  | {
    readonly type: 'subtitles';
    readonly pg: readonly PgTrack[];
    readonly text: { readonly files: readonly TextFileInfo[]; readonly missingFonts: readonly string[]; readonly episodeStarts: readonly number[] } | null;
    readonly selected: 'off' | 'text' | { readonly pg: number };
    readonly scale: number;
  }
  | { readonly type: 'state'; readonly state: PlaybackState }
  | { readonly type: 'time'; readonly timeUs: number }
  | { readonly type: 'notice'; readonly code: NoticeCode; readonly message: string }
  | { readonly type: 'unsupported'; readonly kind: 'video' | 'audio'; readonly codec: string; readonly message: string }
  | { readonly type: 'error'; readonly code: ErrorCode; readonly message: string; readonly paths: readonly string[] }
  | { readonly type: 'telemetry'; readonly telemetry: Telemetry }
  /** The current playlist was torn down (a new pick, a failed pick, or close). */
  | { readonly type: 'playlistCleared' }
  /** On every shader set change and compile result; `error` explains 'error' and 'unavailable'. */
  | { readonly type: 'shaderStatus'; readonly state: ShaderState; readonly set: string | null; readonly error: string | null };
