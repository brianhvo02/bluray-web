import type { ReactElement } from 'react';
import type { TitleDetail } from '../../engine/disc/nas-api';
import type { NasClient } from './nas-client';
import { Poster } from './Poster';
import { DiscList, type OpenDisc } from './SeasonScreen';
import { displayName, seasonCounts, seasonLabel, secondaryName, titleMeta } from './title-model';

interface SeriesScreenProps {
  readonly nas: NasClient;
  readonly detail: TitleDetail;
  readonly onBack: () => void;
  readonly onSeason: (seasonId: string) => void;
  /** The title's own extras (no season known). */
  readonly onExtras: () => void;
  /** A related title: a movie or side story of the series. */
  readonly onTitle: (titleId: string) => void;
  readonly onOpen: OpenDisc;
}

/** A title: banner, poster and names, then its seasons, related movies and extras; a movie or music title lists its discs. */
export function SeriesScreen({ nas, detail, onBack, onSeason, onExtras, onTitle, onOpen }: SeriesScreenProps): ReactElement {
  const { title } = detail;
  const name = displayName(title);
  const native = secondaryName(title);
  const romaji = title.names.romaji !== null && title.names.romaji !== name ? title.names.romaji : null;
  const isSeries = title.kind === 'series';

  return (
    <section className="titles series-screen" data-testid="series-screen" data-title-id={title.id}>
      <div className="series-banner">
        {detail.banner !== null && <Poster nas={nas} artId={detail.banner} name={name} size="large" className="series-banner-art" />}
        <button type="button" className="title-back on-banner" aria-label="Back" onClick={onBack}>
          <span aria-hidden="true">‹</span>
        </button>
      </div>
      <div className="series-head">
        <Poster nas={nas} artId={title.poster} name={name} size="large" className="series-poster" />
        <div className="series-names">
          <h2 data-testid="series-name">{name}</h2>
          {romaji && <span className="title-muted">{romaji}</span>}
          {native && native !== romaji && <span className="title-muted" lang="ja">{native}</span>}
          <span className="series-meta">{titleMeta(detail)}</span>
        </div>
      </div>
      {isSeries ? (
        <ul className="title-list">
          {detail.seasons.map((s) => {
            const label = seasonLabel(s);
            return (
              <li key={s.id}>
                <button type="button" className="title-row" data-testid="season-row" data-label={label} onClick={() => onSeason(s.id)}>
                  <Poster nas={nas} artId={title.poster} name={name} size="small" className="title-thumb" />
                  <span className="title-row-text">
                    <span className="title-row-name">{label}</span>
                    {s.label && s.label !== label && s.label !== name && <span className="title-muted">{s.label}</span>}
                    <span className="title-muted">{seasonCounts(s)}</span>
                  </span>
                  <span className="title-chevron" aria-hidden="true">›</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        detail.seasons.map((s) => <DiscList key={s.id} season={s} discs={s.discs} onOpen={onOpen} />)
      )}
      {detail.related.length > 0 && (
        <ul className="title-list">
          {detail.related.map((r) => (
            <li key={r.id}>
              <button type="button" className="title-row" data-testid="related-row" onClick={() => onTitle(r.id)}>
                <Poster nas={nas} artId={r.poster} name={displayName(r)} size="small" className="title-thumb" />
                <span className="title-row-text">
                  <span className="title-row-name">{displayName(r)}</span>
                  <span className="title-muted">{[r.kind === 'movie' ? 'Movie' : r.kind === 'music' ? 'Music' : 'Series', r.year].filter((x) => x !== null).join(' · ')}</span>
                </span>
                <span className="title-chevron" aria-hidden="true">›</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {detail.extras.length > 0 && (
        <button type="button" className="title-row extras-row" data-testid="extras-row" onClick={onExtras}>
          <span className="title-row-text">
            <span className="title-row-name">Extras</span>
            <span className="title-muted">{detail.extras.length === 1 ? '1 disc' : `${detail.extras.length} discs`}</span>
          </span>
          <span className="title-chevron" aria-hidden="true">›</span>
        </button>
      )}
    </section>
  );
}
