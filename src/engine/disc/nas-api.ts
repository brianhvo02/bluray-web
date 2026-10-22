/** Types shared by the NAS server and the app. No runtime code. */

export interface DiscEntry {
  readonly id: string;
  readonly name: string;
  /** Root-relative, e.g. 'drv5/[250226] きりの森'. This is the key: names can repeat across roots. */
  readonly path: string;
  readonly kind: 'folder' | 'iso';
  readonly sizeBytes: number;
}

export interface FolderEntry {
  readonly name: string;
  readonly path: string;
  /** Discs below it. */
  readonly discs: number;
}

export interface LibraryListing {
  readonly folders: FolderEntry[];
  readonly discs: DiscEntry[];
  readonly scanning: boolean;
}

/** The routes a pairing code leads to: the NAS's HTTPS API base and its WebRTC signalling id. */
export interface CodeRoutes {
  readonly https?: string;
  /** The NAS's signalling id on the rendezvous Worker (`/signal/device?nasId=`); the Worker adds it to every lookup. */
  readonly webrtc?: { readonly nasId: string };
}

/** The rendezvous service's answer to `POST /codes/lookup { code }`. */
export interface CodeLookup {
  readonly nasId: string;
  readonly routes: CodeRoutes;
}

/** `POST /nas`: a NAS registers its P-256 ECDSA public key once and gets its id. */
export interface NasRegistration {
  readonly publicKeyJwk: EcPublicJwk;
}

/** A P-256 public key as a JWK. */
export interface EcPublicJwk {
  readonly kty: 'EC';
  readonly crv: 'P-256';
  readonly x: string;
  readonly y: string;
}

/**
 * `POST /codes`: a NAS registers a code by its hash. `signature` is the NAS key's ECDSA P-256 / SHA-256
 * signature (IEEE P1363, base64url) over the canonical JSON of the other fields.
 */
export interface CodeRegistration {
  readonly nasId: string;
  /** Hex SHA-256 of the normalized code. */
  readonly codeHash: string;
  readonly routes: { readonly https?: string };
  /** Epoch ms; at most 15 minutes ahead. */
  readonly expiresAt: number;
  readonly signature: string;
}

/** One viewing the NAS GPU is encoding, from `GET admin/encoding` (owners only). */
export interface EncodingNow {
  readonly personName: string;
  readonly deviceName: string;
  readonly discName: string;
  readonly level: LevelId;
  readonly label: string;
  readonly gpuPercent: number;
}

/** `GET /api/discs/<id>/manifest`: a folder disc's files, with the small ones the engine reads whole inlined. */
export interface DiscManifest {
  readonly discId: string;
  readonly name: string;
  /** Paths upper-case and relative to the disc folder, like `normalizeDiscPaths`: 'BDMV/STREAM/00001.M2TS'. */
  readonly files: readonly { readonly path: string; readonly size: number }[];
  /** Path → base64 of the whole file. */
  readonly inline: Readonly<Record<string, string>>;
}

/** Why the NAS's title matcher left a disc in Unsorted (spec §7), shown to the owner. */
export type UnsortedReason = 'no-title' | 'several-fit' | 'no-season' | 'episode-past-season' | 'no-disc-number' | 'sources-disagree' | 'source-unreachable';

export type TitleKind = 'series' | 'movie' | 'music';
export interface TitleNames { readonly english: string | null; readonly romaji: string | null; readonly native: string | null; readonly synonyms: readonly string[]; readonly display: string | null }
export interface TitleSummary { readonly id: string; readonly kind: TitleKind; readonly names: TitleNames; readonly poster: string | null; readonly year: number | null; readonly seasons: number; readonly discs: number; readonly addedAt: number; readonly own: boolean }
export interface DiscRef { readonly discId: string; readonly root: string; readonly folder: string; readonly displayName: string | null }
export interface DiscSlot { readonly number: number | null; readonly label: string; readonly copies: readonly DiscRef[] }
export interface EpisodeRef { readonly number: number; readonly name: string | null; readonly runtimeMin: number | null; readonly discId: string; readonly playlistId: string }
/** A movie's or music title's discs are one season with `number: null` and label ''. */
export interface SeasonDetail { readonly id: string; readonly label: string; readonly number: number | null; readonly discs: readonly DiscSlot[]; readonly episodes: readonly EpisodeRef[] | null; readonly extras: readonly DiscSlot[] }
/** `poster` and `banner` are art ids for `GET art/<id>`, never source URLs. */
export interface TitleDetail { readonly title: TitleSummary; readonly banner: string | null; readonly seasons: readonly SeasonDetail[]; readonly related: readonly TitleSummary[]; readonly extras: readonly DiscSlot[] }

/** What the owner decided for one disc (spec §7). */
export type OwnerChoice =
  | { readonly kind: 'title'; readonly titleId: string; readonly season: number | null; readonly disc: number | null }
  | { readonly kind: 'music'; readonly name: string | null }
  | { readonly kind: 'extras'; readonly titleId: string; readonly season: number | null }
  | { readonly kind: 'hidden' };
export interface OwnTitle { readonly id: string; readonly kind: TitleKind; readonly name: string; readonly seasons: number | null }
/**
 * A title suggested for an Unsorted disc, with the season the owner's Season field starts at (ruling F2): the matcher's
 * season for it, else the season the disc's names give, else the entry's place in its chain; null when none is known
 * or the title has no seasons.
 */
export interface UnsortedSuggestion extends TitleSummary { readonly seasonHint: number | null }
export interface UnsortedItem { readonly discId: string; readonly path: string; readonly discTitles: readonly { readonly lang: string; readonly name: string }[]; readonly reason: UnsortedReason; readonly suggestions: readonly UnsortedSuggestion[]; readonly catalogueNumber: string | null; readonly group: string; readonly groupSize: number }

/** The player settings a place carries, so resuming on another device sounds and looks the same. */
/** A text subtitle file of a place: identified by name and size (its bytes stay on the device). */
export interface PlaceTextFile {
  readonly name: string; readonly size: number; readonly startUs: number | null; readonly offsetMs: number;
  /** A subtitle stored on the NAS (piece 3): its id, fetched again on a resume, and its language, which Up next carries. */
  readonly subtitleId?: string; readonly language?: string;
}
export interface PlaceSettings { readonly audioLanguage: string | null; readonly pgLanguage: string | null; readonly textFiles: readonly PlaceTextFile[]; readonly psr1: number; readonly psr2: number; readonly psr3: number; readonly textOn: boolean; readonly textScale: number; readonly shaderSet: string | null; readonly volume: number; readonly muted: boolean }
/** Where one person stopped in one playlist of a disc (spec: resume). `finished` places stay for Up next, and go first when the store is full. */
export interface PlaybackPlace {
  readonly discKey: string; readonly discId: string; readonly playlistId: string;
  readonly timeUs: number; readonly durationUs: number; readonly finished: boolean;
  readonly mode: 'hdmv' | 'bdj' | 'none'; readonly title: number | null;
  readonly psrs: readonly number[]; readonly gprs: Readonly<Record<number, number>> | null;
  readonly settings: PlaceSettings; readonly updatedAt: number; readonly deviceName: string;
}
/** One person's places in one disc: by playlist id, with the settings of the latest put as `defaults`. */
export interface DiscPlaces { readonly defaults: PlaceSettings | null; readonly places: Readonly<Record<string, PlaybackPlace>> }

/** One card of the Continue watching row. `up-next` is the episode after a finished one, to start from the beginning. */
export interface ContinueItem {
  readonly kind: 'resume' | 'up-next';
  readonly discKey: string; readonly discId: string; readonly playlistId: string;
  readonly timeUs: number; readonly durationUs: number;
  readonly titleId: string | null; readonly titleName: string | null; readonly poster: string | null;
  readonly seasonId: string | null; readonly seasonNumber: number | null; readonly episode: number | null;
  readonly kindOfTitle: TitleKind | null; readonly updatedAt: number; readonly deviceName: string;
  /** An Up next card's: the finished episode's settings, which carry on to the next (by language, spec §6.6); null on a resume card. */
  readonly settings: PlaceSettings | null;
}

export interface PlaylistProgress { readonly timeUs: number; readonly durationUs: number; readonly finished: boolean }

/** What a stored subtitle is for: one episode's playlist, or the start of a chapter of a disc's playlist. */
export type SubtitleAttachment =
  | { readonly kind: 'episode'; readonly discKey: string; readonly playlistId: string; readonly titleId: string; readonly seasonId: string; readonly episode: number }
  /** `titleId`: the title it was uploaded from, so its owners still find it there when the disc is gone (listing only). */
  | { readonly kind: 'chapter'; readonly discKey: string; readonly playlistId: string; readonly chapter: number; readonly titleId?: string };
/**
 * What a subtitle is for when it is registered or moved: an episode of a title's season, or a chapter of a disc's
 * playlist (with the title it is uploaded from, which the app always sends).
 */
export type SubtitleFor =
  | { readonly kind: 'episode'; readonly titleId: string; readonly seasonId: string; readonly episode: number }
  | { readonly kind: 'chapter'; readonly discId: string; readonly playlistId: string; readonly chapter: number; readonly titleId?: string };
/** The body of `POST /api/subtitles`. */
export interface SubtitleCreate { readonly name: string; readonly language: string; readonly offsetMs?: number; readonly for: SubtitleFor }
/** The body of `PATCH /api/subtitles/<id>`: any of these. */
export type SubtitlePatch = Partial<SubtitleCreate>;
/** A subtitle file (SRT or ASS) an owner uploaded to the NAS, with its fonts. */
export interface StoredSubtitle {
  readonly id: string; readonly name: string; readonly language: string; readonly offsetMs: number;
  readonly fileName: string; readonly fileSize: number; readonly fonts: readonly { readonly name: string; readonly size: number }[];
  readonly attachment: SubtitleAttachment; readonly uploadedAt: number;
  /** Who uploaded it; in answers to owners only. */
  readonly uploaderPersonId?: string;
  /** Set by the route: false when the attachment's disc or playlist no longer resolves (owners only see these). */
  readonly attached?: boolean;
}

/** The quality levels a disc can be served at; `original` is the disc's own bytes. */
export type LevelId = 'original' | 'h264-1080' | 'phone-720' | 'hevc-1080' | 'hevc-1080-hdr' | 'h264-1080-sdr';

/** Why a level isn't available: `no-encoder` when the NAS's encoder for its codec failed its self-test (or has none). */
export type LevelReason = 'unplayable' | 'no-encoder' | 'no-hevc' | 'no-hevc10' | 'no-hdr-display' | 'busy';

/** One entry of `GET discs/<id>/levels`. */
export interface LevelInfo {
  readonly level: LevelId;
  readonly label: string;
  /** The rate the level travels at (its byte budget over the main clip's film, padding included), Mbps to 0.1. */
  readonly budgetMbps: number;
  readonly available: boolean;
  readonly reason?: LevelReason;
}

/** A version of a disc: a level with the audio stream it keeps (`audio` is 1-based, as PSR1). */
export interface LevelAt {
  readonly level: LevelId;
  readonly audio: number;
}
