import { parseClpi } from '../../engine/bdmv/clpi-parser';
import { parseMpls, type Mpls } from '../../engine/bdmv/mpls-parser';
import { CodingType, isVideoCoding } from '../../engine/bdmv/stream-types';
import type { DiscEntry, DiscManifest, FolderEntry } from '../../engine/disc/nas-api';
import { chooseMainTitle, type MainTitleCandidate } from '../../engine/disc/main-title';
import { clipInfoPath, streamPath } from '../../engine/disc/open-disc';

export interface Crumb {
  readonly label: string;
  /** Root-relative folder path; '' is the top of the NAS. */
  readonly path: string;
}

/** 'drv5/[250226] きりの森' → NAS › drv5 › [250226] きりの森, each with the folder it opens. */
export function breadcrumbs(path: string): Crumb[] {
  const crumbs: Crumb[] = [{ label: 'NAS', path: '' }];
  const parts = path.split('/').filter((p) => p !== '');
  parts.forEach((part, i) => crumbs.push({ label: part, path: parts.slice(0, i + 1).join('/') }));
  return crumbs;
}

export type LibraryRow = { readonly kind: 'folder'; readonly folder: FolderEntry } | { readonly kind: 'disc'; readonly disc: DiscEntry };

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name, 'ja');

/** Folders first, then discs, each in Japanese collation order. */
export function sortRows(listing: { readonly folders: readonly FolderEntry[]; readonly discs: readonly DiscEntry[] }): LibraryRow[] {
  return [
    ...[...listing.folders].sort(byName).map((folder): LibraryRow => ({ kind: 'folder', folder })),
    ...[...listing.discs].sort(byName).map((disc): LibraryRow => ({ kind: 'disc', disc })),
  ];
}

/** `ISO` for disc images; `UHD` once the disc's manifest has shown an HEVC 2160p main title (undefined: not known yet). */
export function discBadges(disc: DiscEntry, uhd: boolean | undefined): string[] {
  const badges: string[] = [];
  if (disc.kind === 'iso') badges.push('ISO');
  if (uhd) badges.push('UHD');
  return badges;
}

/** Decimal units, one decimal place above bytes: '46.1 GB'. */
export function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
}

export interface DiscFacts {
  /** The main title's peak rate (its first clip's TS_recording_rate) in megabits per second; null when unknown. */
  readonly peakMbps: number | null;
  /** The main title is HEVC 2160p. */
  readonly uhd: boolean;
}

/** BD video_format code of 2160p. */
const VIDEO_FORMAT_2160P = 8;

function inlined(manifest: DiscManifest, path: string): Uint8Array | null {
  const base64 = manifest.inline[path];
  if (base64 === undefined) return null;
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * What the manifest's inlined playlists and clip info say about the main title, read with the engine's parsers and
 * its (libbluray's) choice of main title among the playlists whose clips are all on the disc.
 */
export function discFacts(manifest: DiscManifest): DiscFacts {
  const unknown: DiscFacts = { peakMbps: null, uhd: false };
  try {
    const files = new Set(manifest.files.map((f) => f.path));
    const candidates: MainTitleCandidate[] = [];
    for (const path of Object.keys(manifest.inline).sort()) {
      const m = /^BDMV\/PLAYLIST\/(\d{5})\.MPLS$/.exec(path);
      const bytes = m && inlined(manifest, path);
      if (!m || !bytes) continue;
      let mpls: Mpls;
      try {
        mpls = parseMpls(bytes);
      } catch {
        continue;
      }
      const hasVideo = mpls.playItems.length > 0 && mpls.playItems[0]!.stn.video.some((v) => !v.subPath);
      const complete = mpls.playItems.every((p) => files.has(clipInfoPath(p.clipId)) && files.has(streamPath(p.clipId)));
      if (hasVideo && complete) candidates.push({ id: m[1]!, mpls });
    }
    const mainId = chooseMainTitle(candidates);
    const clipId = candidates.find((c) => c.id === mainId)?.mpls.playItems[0]?.clipId;
    const clpiBytes = clipId === undefined ? null : inlined(manifest, clipInfoPath(clipId));
    if (!clpiBytes) return unknown;
    const clip = parseClpi(clpiBytes);
    const video = clip.programs.flatMap((p) => p.streams).find((s) => isVideoCoding(s.codingType));
    return {
      // TS_recording_rate is in bytes per second.
      peakMbps: clip.recordingRate > 0 ? (clip.recordingRate * 8) / 1e6 : null,
      uhd: video?.codingType === CodingType.HEVC && video.format === VIDEO_FORMAT_2160P,
    };
  } catch {
    return unknown;
  }
}

/** `This connection: N Mbps`, and a warning when the disc's peak rate is above it; nothing without a measurement. */
export function preflightLines(connectionMbps: number | null, peakMbps: number | null): string[] {
  if (connectionMbps === null) return [];
  const lines = [`This connection: ${Math.round(connectionMbps)} Mbps`];
  if (peakMbps !== null && peakMbps > connectionMbps) lines.push(`This disc needs about ${Math.round(peakMbps)} Mbps; expect pauses.`);
  return lines;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const FOLDER_KEY = 'bluray-web:nas-folder';

/** The folder the library was last showing, kept in `storage` (localStorage) when it works; '' (the top) otherwise. */
export function folderMemory(storage: StorageLike | undefined): { get(): string; set(path: string): void } {
  return {
    get: () => {
      try {
        return storage?.getItem(FOLDER_KEY) ?? '';
      } catch {
        return '';
      }
    },
    set: (path) => {
      try {
        storage?.setItem(FOLDER_KEY, path);
      } catch {
        // Remembering the folder is a convenience.
      }
    },
  };
}
