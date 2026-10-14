import { parseClpi, type Clpi } from '../bdmv/clpi-parser';
import { indexUsesBdj, parseIndex, type IndexBdmv } from '../bdmv/index-parser';
import { MarkType, parseMpls, type Mpls } from '../bdmv/mpls-parser';
import { ALIGNED_UNIT_SIZE, SOURCE_PACKET_SIZE } from '../demux/constants';
import { ParseError } from '../util/byte-reader';
import { ticks45ToUs } from '../util/time';
import { DiscError, readWhole, type ByteSource } from './byte-source';
import { chooseMainTitle, hasRepeatedSegments } from './main-title';

const INDEX_PATH = 'BDMV/INDEX.BDMV';

export const playlistPath = (id: string): string => `BDMV/PLAYLIST/${id}.MPLS`;
export const clipInfoPath = (clipId: string): string => `BDMV/CLIPINF/${clipId}.CLPI`;
export const streamPath = (clipId: string): string => `BDMV/STREAM/${clipId}.M2TS`;

export interface PlaylistSummary {
  readonly id: string;
  readonly durationUs: number;
  readonly chapterCount: number;
  readonly clipIds: readonly string[];
  readonly playable: boolean;
  readonly missingPaths: readonly string[];
  /** Plays one segment more than twice (a maze or loop playlist); never chosen as the main feature. */
  readonly looped: boolean;
}

export interface DiscModel {
  readonly index: IndexBdmv;
  readonly usesBdj: boolean;
  readonly playlists: ReadonlyMap<string, Mpls>;
  /** The main feature first (libbluray's choice among playable playlists), then the rest longest first, loops last. */
  readonly summaries: readonly PlaylistSummary[];
  readonly warnings: readonly string[];
}

export async function openDisc(source: ByteSource): Promise<DiscModel> {
  const playlistFiles = source.list('BDMV/PLAYLIST').filter((name) => name.endsWith('.MPLS'));
  const missing: string[] = [];
  if (!source.exists(INDEX_PATH)) missing.push(INDEX_PATH);
  if (playlistFiles.length === 0) missing.push('BDMV/PLAYLIST/*.MPLS');
  if (missing.length > 0) throw new DiscError('not-bdmv', 'This folder is not a Blu-ray (BDMV) backup.', missing);

  let index: IndexBdmv;
  try {
    index = parseIndex(await readWhole(source, INDEX_PATH));
  } catch (err) {
    if (err instanceof ParseError) throw new DiscError('not-bdmv', `index.bdmv is damaged: ${err.message}`, [INDEX_PATH]);
    throw err;
  }

  const playlists = new Map<string, Mpls>();
  const warnings: string[] = [];
  for (const name of playlistFiles) {
    const id = name.slice(0, -'.MPLS'.length);
    try {
      playlists.set(id, parseMpls(await readWhole(source, playlistPath(id))));
    } catch (err) {
      if (!(err instanceof ParseError)) throw err;
      warnings.push(`Skipped playlist ${id}: ${err.message}`);
    }
  }

  const all = [...playlists].map(([id, mpls]) => summarize(source, id, mpls));
  const mainId = chooseMainTitle(all.filter((s) => s.playable).map((s) => ({ id: s.id, mpls: playlists.get(s.id) as Mpls })));
  const rank = (s: PlaylistSummary): number => (s.id === mainId ? 0 : s.looped ? 2 : 1);
  const summaries = all.sort((a, b) => rank(a) - rank(b) || b.durationUs - a.durationUs || a.id.localeCompare(b.id));
  const main = summaries.find((s) => s.playable);
  if (main) await checkStreamReadable(source, main.clipIds[0]);
  return { index, usesBdj: indexUsesBdj(index), playlists, summaries, warnings };
}

function summarize(source: ByteSource, id: string, mpls: Mpls): PlaylistSummary {
  const clipIds = [...new Set(mpls.playItems.map((p) => p.clipId))];
  const missingPaths = clipIds.flatMap((c) => [clipInfoPath(c), streamPath(c)]).filter((p) => !source.exists(p));
  const duration45 = mpls.playItems.reduce((sum, p) => sum + Math.max(0, p.outTime - p.inTime), 0);
  const hasVideo = mpls.playItems.length > 0 && mpls.playItems[0].stn.video.some((v) => !v.subPath);
  return {
    id,
    durationUs: ticks45ToUs(duration45),
    chapterCount: mpls.marks.filter((m) => m.type === MarkType.ENTRY).length,
    clipIds,
    playable: hasVideo && missingPaths.length === 0,
    missingPaths,
    looped: hasRepeatedSegments(mpls),
  };
}

export async function loadClips(source: ByteSource, clipIds: readonly string[]): Promise<Map<string, Clpi>> {
  const clips = new Map<string, Clpi>();
  for (const clipId of clipIds) {
    const path = clipInfoPath(clipId);
    if (!source.exists(path)) throw new DiscError('missing-file', `Missing clip info ${path}`, [path]);
    clips.set(clipId, parseClpi(await readWhole(source, path)));
  }
  return clips;
}

/** Encrypted aligned units keep only the first 16 bytes in the clear, so later packets lose their sync byte. */
export async function checkStreamReadable(source: ByteSource, clipId: string): Promise<void> {
  const path = streamPath(clipId);
  const bytes = await source.read(path, 0, ALIGNED_UNIT_SIZE);
  const packets = Math.floor(bytes.length / SOURCE_PACKET_SIZE);
  let readable = packets > 0;
  for (let k = 0; k < packets && readable; k++) {
    if (bytes[k * SOURCE_PACKET_SIZE + 4] !== 0x47) readable = false;
  }
  if (readable) return;
  if (source.list('AACS').length > 0) {
    throw new DiscError('encrypted', 'This disc appears to be encrypted (AACS). Only decrypted backups are supported.', [path]);
  }
  throw new DiscError('unreadable-stream', 'The video stream could not be read. The backup may be damaged or encrypted.', [path]);
}
