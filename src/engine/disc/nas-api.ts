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

/** The routes a pairing code leads to: the NAS's HTTPS API base (and, later, WebRTC). */
export interface CodeRoutes {
  readonly https?: string;
  readonly webrtc?: true;
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

/** What the owner decided for one disc (spec §7). */
export type OwnerChoice =
  | { readonly kind: 'title'; readonly titleId: string; readonly season: number | null; readonly disc: number | null }
  | { readonly kind: 'music'; readonly name: string | null }
  | { readonly kind: 'extras'; readonly titleId: string; readonly season: number | null }
  | { readonly kind: 'hidden' };
export interface OwnTitle { readonly id: string; readonly kind: TitleKind; readonly name: string; readonly seasons: number | null }
export interface UnsortedItem { readonly discId: string; readonly path: string; readonly discTitles: readonly { readonly lang: string; readonly name: string }[]; readonly reason: UnsortedReason; readonly suggestions: readonly TitleSummary[]; readonly catalogueNumber: string | null; readonly group: string; readonly groupSize: number }
