/**
 * The episode guess from playlists (spec §8): episode-length playlists, numbered in disc order. It answers null,
 * meaning no Episodes tab, whenever it is unsure (ruling T7d). Original code.
 */
import type { EpisodeRef } from '../../../src/engine/disc/nas-api';
import type { DiscEvidence } from './evidence';

type Playlist = DiscEvidence['playlists'][number];

/** Playlists within this share of the season's episode runtime are episodes. */
const RUNTIME_TOLERANCE = 0.25;

const naturalOrder = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });

/**
 * The episodes of a season's discs, given in disc order, numbered from `firstNumber` and continuing from disc to disc;
 * null when the runtime or episode count is unknown, when a disc's episodes can't be ordered, or when the total isn't
 * the season's episode count.
 */
export function guessEpisodes(
  season: { episodes: number | null; runtimeMin: number | null },
  discs: readonly { discId: string; playlists: DiscEvidence['playlists'] }[],
  firstNumber: number,
): EpisodeRef[] | null {
  const { episodes, runtimeMin } = season;
  if (episodes === null || runtimeMin === null || runtimeMin <= 0) return null;
  const out: EpisodeRef[] = [];
  for (const d of discs) {
    const found = discEpisodes(d.playlists, runtimeMin * 60);
    if (found === null) return null;
    for (const p of found) {
      out.push({ number: firstNumber + out.length, name: null, runtimeMin: Math.round(p.durationS / 60), discId: d.discId, playlistId: p.id });
    }
  }
  return out.length === episodes ? out : null;
}

/**
 * One disc's episode playlists in order, or null when they can't be ordered. Play-all playlists (at least two
 * episodes long) and short ones (openings, endings, previews) fall outside the runtime window. Playlists with the same
 * clip list count once. Clips shared by several episodes (an opening, an ending) are allowed, but each episode needs a
 * clip of its own, and those clips must run in playlist order.
 */
function discEpisodes(playlists: readonly Playlist[], runtimeS: number): Playlist[] | null {
  const lo = runtimeS * (1 - RUNTIME_TOLERANCE);
  const hi = runtimeS * (1 + RUNTIME_TOLERANCE);
  const seen = new Set<string>();
  const candidates: Playlist[] = [];
  for (const p of [...playlists].sort((a, b) => naturalOrder(a.id, b.id))) {
    const key = p.clips.join('/');
    if (p.clips.length === 0 || p.durationS < lo || p.durationS > hi || seen.has(key)) continue;
    seen.add(key);
    candidates.push(p);
  }
  const uses = new Map<string, number>();
  for (const p of candidates) for (const c of new Set(p.clips)) uses.set(c, (uses.get(c) ?? 0) + 1);
  let previous: string | null = null;
  for (const p of candidates) {
    const own = p.clips.find((c) => uses.get(c) === 1);
    if (own === undefined) return null;
    if (previous !== null && naturalOrder(previous, own) >= 0) return null;
    previous = own;
  }
  return candidates;
}
