/** Disc keys and playlist lengths from the library's evidence, for the fansub runs, picks and routes. Original code. */
import { parseDiscKey } from '../../../src/engine/disc/disc-key';
import type { Library } from '../library';

export interface FansubDiscs {
  /** The key a disc's links carry (`f.<fingerprint>`, else `d.<disc id>`); null for a disc the library doesn't list. */
  discKey(discId: string): string | null;
  /** The listed discs a key stands for: every copy with that fingerprint. */
  discIds(discKey: string): string[];
  durationMs(discId: string, playlistId: string): number | null;
}

export function libraryFansubDiscs(library: Pick<Library, 'evidence'>): FansubDiscs {
  const find = (discId: string) => library.evidence().find((e) => e.discId === discId);
  return {
    discKey: (discId) => {
      const ev = find(discId);
      return ev ? (ev.fingerprint ? `f.${ev.fingerprint}` : `d.${ev.discId}`) : null;
    },
    discIds: (discKey) => {
      const parsed = parseDiscKey(discKey);
      if (!parsed) return [];
      return library.evidence()
        .filter((e) => (parsed.kind === 'disc' ? e.discId === parsed.discId : e.fingerprint === parsed.fingerprint))
        .map((e) => e.discId);
    },
    durationMs: (discId, playlistId) => {
      const p = find(discId)?.playlists.find((x) => x.id === playlistId);
      return p ? Math.round(p.durationS * 1000) : null;
    },
  };
}
