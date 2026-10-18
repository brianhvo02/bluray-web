import { useState, type ReactElement } from 'react';
import type { DiscRef, DiscSlot, EpisodeRef, SeasonDetail } from '../../engine/disc/nas-api';
import type { PreflightDisc } from './Preflight';
import { copiesLabel, discHeading, episodeMeta } from './title-model';

/** Opens a disc's pre-flight, at an episode's playlist when one is given. */
export type OpenDisc = (disc: PreflightDisc, playlistId?: string) => void;

const lastSegment = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** A title's disc as the pre-flight shows it: its display name or folder name; its size comes from the manifest. */
export function preflightDisc(ref: DiscRef): PreflightDisc {
  return { id: ref.discId, name: ref.displayName ?? lastSegment(ref.folder), kind: ref.folder.toLowerCase().endsWith('.iso') ? 'iso' : 'folder', sizeBytes: null };
}

interface DiscListProps {
  readonly season: SeasonDetail;
  readonly discs: readonly DiscSlot[];
  readonly onOpen: OpenDisc;
}

/** Disc cards: the disc and its episodes, how many copies, then one line per copy (drive and folder) that opens it. */
export function DiscList({ season, discs, onOpen }: DiscListProps): ReactElement {
  return (
    <ul className="title-list">
      {discs.map((d, i) => {
        const copies = copiesLabel(d);
        return (
          <li key={`${d.label}:${i}`} className="disc-card" data-testid="disc-card">
            <div className="disc-card-head">
              <span className="title-row-name">{discHeading(season, d)}</span>
              {copies && <span className="title-muted">{copies}</span>}
            </div>
            {d.copies.map((c) => (
              <button key={c.discId} type="button" className="disc-copy" data-testid="disc-copy" onClick={() => onOpen(preflightDisc(c))}>
                <span className="disc-copy-drive">{c.root}</span>
                <span className="disc-copy-folder">{c.folder}</span>
              </button>
            ))}
          </li>
        );
      })}
    </ul>
  );
}

interface SeasonScreenProps {
  readonly seriesName: string;
  /** 'Season 2', 'Extras', … */
  readonly heading: string;
  readonly season: SeasonDetail;
  readonly onBack: () => void;
  readonly onOpen: OpenDisc;
}

/** A season: Episodes and Discs tabs, or the discs alone when its episodes aren't known. */
export function SeasonScreen({ seriesName, heading, season, onBack, onOpen }: SeasonScreenProps): ReactElement {
  const episodes = season.episodes;
  const [tab, setTab] = useState<'episodes' | 'discs'>(episodes ? 'episodes' : 'discs');

  const playEpisode = (e: EpisodeRef): void => {
    const copy = season.discs.flatMap((d) => d.copies).find((c) => c.discId === e.discId);
    const disc = copy ? preflightDisc(copy) : { id: e.discId, name: '', kind: 'folder' as const, sizeBytes: null };
    onOpen({ ...disc, name: disc.name ? `Episode ${e.number} · ${disc.name}` : `Episode ${e.number}` }, e.playlistId);
  };

  return (
    <section className="titles season-screen" data-testid="season-screen">
      <header className="season-head">
        <button type="button" className="title-back" aria-label={`Back to ${seriesName}`} onClick={onBack}>
          <span aria-hidden="true">‹</span>
        </button>
        <div className="season-head-text">
          <span className="title-muted">{seriesName}</span>
          <h2>{heading}</h2>
        </div>
      </header>
      {episodes && (
        <div className="segmented" role="tablist" aria-label="Show">
          {(['episodes', 'discs'] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'selected' : ''} data-testid="season-tab" data-tab={t} onClick={() => setTab(t)}>
              {t === 'episodes' ? 'Episodes' : 'Discs'}
            </button>
          ))}
        </div>
      )}
      {episodes && tab === 'episodes' ? (
        <ul className="title-list" role="tabpanel">
          {episodes.map((e) => (
            <li key={`${e.discId}:${e.playlistId}`}>
              <button type="button" className="episode-row" data-testid="episode-row" data-number={e.number} onClick={() => playEpisode(e)}>
                <span className="episode-number">{e.number}</span>
                <span className="title-row-text">
                  <span className="title-row-name">
                    Episode {e.number}
                    {e.name && <span className="title-muted"> · {e.name}</span>}
                  </span>
                  <span className="title-muted">{episodeMeta(season, e)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div role={episodes ? 'tabpanel' : undefined}>
          <DiscList season={season} discs={season.discs} onOpen={onOpen} />
          {season.extras.length > 0 && (
            <>
              <h3 className="title-section">Extras</h3>
              <DiscList season={{ ...season, episodes: null }} discs={season.extras} onOpen={onOpen} />
            </>
          )}
        </div>
      )}
    </section>
  );
}
