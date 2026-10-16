/*
 * A set of text subtitle files for one playlist, each placed at an episode start: which file shows at a playlist
 * time and at what time inside it, per-file offsets, and placement by play items.
 *
 * Original implementation for bluray-web, 2026; contains no libass, libbluray or FFmpeg code.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

export interface SetFile<R> { readonly name: string; readonly format: 'srt' | 'ass'; readonly cues: number; readonly renderer: R }
export interface Placement { readonly startUs: number | null; readonly offsetMs: number }

export const MIN_EPISODE_US = 5 * 60 * 1_000_000;
const MAX_OFFSET_MS = 10 * 60 * 1000;

/** Play item starts lasting at least MIN_EPISODE_US; every item start when none does. Playlist time, sorted. */
export function episodeStarts(items: readonly { readonly startUs: number; readonly durationUs: number }[]): number[] {
  const long = items.filter((i) => i.durationUs >= MIN_EPISODE_US);
  return (long.length ? long : items).map((i) => i.startUs).sort((a, b) => a - b);
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Name order with numeric collation (ep2 before ep10). */
export function sortByName<T extends { readonly name: string }>(files: readonly T[]): T[] {
  return [...files].sort((a, b) => collator.compare(a.name, b.name));
}

/** File n at episode start n when the counts match; else the first file at the playlist start and the rest unplaced. */
export function autoPlace(fileCount: number, starts: readonly number[]): { readonly placements: Placement[]; readonly placed: boolean } {
  if (fileCount === starts.length) return { placements: starts.map((startUs) => ({ startUs, offsetMs: 0 })), placed: true };
  const placements = Array.from({ length: fileCount }, (_, i) => ({ startUs: i === 0 ? 0 : null, offsetMs: 0 }));
  return { placements, placed: fileCount <= 1 };
}

export class TextSet<R> {
  private readonly byPlaylist = new Map<string, Placement[]>();
  private current: Placement[];

  constructor(readonly files: readonly SetFile<R>[]) {
    this.current = autoPlace(files.length, [0]).placements;
  }

  /** Placements for a playlist: the remembered ones, else automatic placement (`placed` says whether it worked). */
  usePlaylist(playlistId: string, starts: readonly number[]): { readonly placed: boolean } {
    const known = this.byPlaylist.get(playlistId);
    if (known) {
      this.current = known;
      return { placed: true };
    }
    const auto = autoPlace(this.files.length, starts);
    this.current = auto.placements;
    this.byPlaylist.set(playlistId, this.current);
    return { placed: auto.placed };
  }

  placements(): readonly Placement[] {
    return this.current;
  }

  /** Places a file; another file at the same start is unplaced. */
  setStart(file: number, startUs: number | null): void {
    this.current.forEach((p, i) => {
      if (i === file) this.current[i] = { ...p, startUs };
      else if (startUs !== null && p.startUs === startUs) this.current[i] = { ...p, startUs: null };
    });
  }

  setOffset(file: number, ms: number): void {
    const p = this.current[file];
    if (p) this.current[file] = { ...p, offsetMs: Math.max(-MAX_OFFSET_MS, Math.min(MAX_OFFSET_MS, Math.round(ms))) };
  }

  private placed(): { file: number; startUs: number }[] {
    return this.current
      .map((p, file) => ({ file, startUs: p.startUs }))
      .filter((p): p is { file: number; startUs: number } => p.startUs !== null)
      .sort((a, b) => a.startUs - b.startUs);
  }

  /** The file whose window [start, next placed start) holds `playlistUs`, and its local time after the offset. */
  at(playlistUs: number): { readonly file: number; readonly renderer: R; readonly localUs: number } | null {
    let hit: { file: number; startUs: number } | null = null;
    for (const p of this.placed()) {
      if (p.startUs <= playlistUs) hit = p;
      else break;
    }
    if (!hit) return null;
    return { file: hit.file, renderer: this.files[hit.file]!.renderer, localUs: playlistUs - hit.startUs - this.current[hit.file]!.offsetMs * 1000 };
  }

  /** The next window boundary after `playlistUs`, or null. */
  nextBoundary(playlistUs: number): number | null {
    return this.placed().find((p) => p.startUs > playlistUs)?.startUs ?? null;
  }
}
