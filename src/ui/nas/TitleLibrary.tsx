import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { SeasonDetail, TitleDetail, TitleKind, TitleSummary } from '../../engine/disc/nas-api';
import type { PlayerController } from '../../player/player-controller';
import { AdminScreen } from './AdminScreen';
import { NasHttpError, type NasClient } from './nas-client';
import { Poster } from './Poster';
import { Preflight, type PreflightDisc } from './Preflight';
import { SeasonScreen } from './SeasonScreen';
import { SeriesScreen } from './SeriesScreen';
import { displayName, recentlyAdded, searchTitles, seasonLabel, secondaryName, shelf } from './title-model';

interface TitleLibraryProps {
  readonly nas: NasClient;
  readonly controller: PlayerController;
  /** From `GET me`: owners get the settings and the Unsorted shelf. */
  readonly owner: boolean;
  /** "Browse by folder instead": the folder browser. */
  readonly onFolders: () => void;
  readonly onClose: () => void;
}

type Shelf = TitleKind | 'unsorted';

const SHELVES: readonly { readonly id: Shelf; readonly label: string }[] = [
  { id: 'series', label: 'Series' },
  { id: 'movie', label: 'Movies' },
  { id: 'music', label: 'Music' },
  { id: 'unsorted', label: 'Unsorted' },
];

/**
 * What the library fetched this session (spec §10: the title list once per session), per NAS client, so leaving and
 * coming back, or going back from a title, doesn't fetch again.
 */
const sessionCache = new WeakMap<NasClient, { titles?: Promise<TitleSummary[]>; details: Map<string, Promise<TitleDetail>> }>();
function cacheOf(nas: NasClient): { titles?: Promise<TitleSummary[]>; details: Map<string, Promise<TitleDetail>> } {
  let cache = sessionCache.get(nas);
  if (!cache) sessionCache.set(nas, (cache = { details: new Map() }));
  return cache;
}
/** A cached request, forgotten if it fails so the next visit asks again. */
function cached<T>(get: () => Promise<T> | undefined, set: (p: Promise<T> | undefined) => void, load: () => Promise<T>): Promise<T> {
  const hit = get();
  if (hit) return hit;
  const p = load();
  set(p);
  p.catch(() => {
    if (get() === p) set(undefined);
  });
  return p;
}
const loadTitles = (nas: NasClient): Promise<TitleSummary[]> => {
  const c = cacheOf(nas);
  return cached(() => c.titles, (p) => (c.titles = p), () => nas.titles());
};
const loadTitle = (nas: NasClient, id: string): Promise<TitleDetail> => {
  const { details } = cacheOf(nas);
  return cached(() => details.get(id), (p) => (p ? details.set(id, p) : details.delete(id)), () => nas.title(id));
};

/** Title routes answer 404 to a guest once the gate is closed (ruling T9c). */
const isGateClosed = (err: unknown): boolean => err instanceof NasHttpError && err.status === 404;
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Pseudo-season holding a title's own extras, shown like a season without episodes. */
const extrasSeason = (d: TitleDetail): SeasonDetail => ({ id: `${d.title.id}#extras`, label: 'Extras', number: null, discs: d.extras, episodes: null, extras: [] });

interface TitleCardProps {
  readonly nas: NasClient;
  readonly title: TitleSummary;
  readonly onOpen: (id: string) => void;
}

function TitleCard({ nas, title, onOpen }: TitleCardProps): ReactElement {
  const name = displayName(title);
  const native = secondaryName(title);
  return (
    <li>
      <button type="button" className="title-card" data-testid="title-card" data-name={name} data-title-id={title.id} onClick={() => onOpen(title.id)}>
        <Poster nas={nas} artId={title.poster} name={name} size="small" className="title-poster" />
        <span className="title-card-name">{name}</span>
        {native && (
          <span className="title-muted title-card-native" lang="ja">
            {native}
          </span>
        )}
      </button>
    </li>
  );
}

function TitleRow({ nas, title, onOpen }: TitleCardProps): ReactElement {
  const name = displayName(title);
  const native = secondaryName(title);
  return (
    <li>
      <button type="button" className="title-row" data-testid="title-row" data-name={name} data-title-id={title.id} onClick={() => onOpen(title.id)}>
        <Poster nas={nas} artId={title.poster} name={name} size="small" className="title-thumb" />
        <span className="title-row-text">
          <span className="title-row-name">{name}</span>
          {native && (
            <span className="title-muted" lang="ja">
              {native}
            </span>
          )}
        </span>
        <span className="title-chevron" aria-hidden="true">›</span>
      </button>
    </li>
  );
}

/** The NAS by title (spec §14, mockups 1–3): search, shelves, recently added and A–Z, then a title's seasons and discs. */
export function TitleLibrary({ nas, controller, owner, onFolders, onClose }: TitleLibraryProps): ReactElement {
  const [titles, setTitles] = useState<TitleSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Shelf | null>(null);
  const [unsorted, setUnsorted] = useState<number | null>(null);
  /** The titles opened, innermost last (a series, then a movie related to it). */
  const [stack, setStack] = useState<string[]>([]);
  const [detail, setDetail] = useState<TitleDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  /** The open season of the innermost title, or 'extras' for its own extras. */
  const [seasonId, setSeasonId] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ disc: PreflightDisc; playlistId?: string } | null>(null);
  const [settings, setSettings] = useState(false);
  const [deviceId, setDeviceId] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    loadTitles(nas).then(
      (list) => {
        if (live) setTitles(list);
      },
      (err: unknown) => {
        if (!live) return;
        // The gate closed since `me` answered: the folder browser, as for any guest.
        if (isGateClosed(err)) onFolders();
        else setError(message(err));
      },
    );
    return () => {
      live = false;
    };
  }, [nas, onFolders]);

  useEffect(() => {
    if (!owner) return;
    let live = true;
    nas.admin.titleStatus().then(
      (s) => {
        if (live) setUnsorted(s.unsorted);
      },
      () => {},
    );
    nas.pairing().then(
      (p) => {
        if (live) setDeviceId(p?.deviceId ?? null);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [nas, owner]);

  const openId = stack.at(-1) ?? null;
  useEffect(() => {
    setDetail(null);
    setDetailError(null);
    if (openId === null) return;
    let live = true;
    loadTitle(nas, openId).then(
      (d) => {
        if (live) setDetail(d);
      },
      (err: unknown) => {
        if (!live) return;
        // As for the list: the gate closed meanwhile, so the folder browser, with no raw error.
        if (isGateClosed(err)) onFolders();
        else setDetailError(message(err));
      },
    );
    return () => {
      live = false;
    };
  }, [nas, openId, onFolders]);

  /**
   * Focus follows the screens: an opened title or season focuses its heading, and going back focuses the item that
   * opened it (the button that had focus is gone with its screen). `focusNext` is applied once its element renders.
   */
  const focusNext = useRef<string | null>(null);
  const returnFocus = useRef<string[]>([]);
  useEffect(() => {
    if (focusNext.current === null) return;
    const el = document.querySelector<HTMLElement>(focusNext.current);
    if (!el) return; // not rendered yet (a title still loading)
    focusNext.current = null;
    el.focus();
  });
  const forward = (opener: string): void => {
    returnFocus.current.push(opener);
    focusNext.current = '[data-focus-heading]';
  };
  const backward = (): void => {
    focusNext.current = returnFocus.current.pop() ?? null;
  };
  const byAttr = (name: string, value: string): string => `[${name}="${CSS.escape(value)}"]`;

  const openTitle = useCallback((id: string) => {
    forward(byAttr('data-title-id', id));
    setSeasonId(null);
    setStack((s) => [...s, id]);
  }, []);
  const back = (): void => {
    backward();
    setSeasonId(null);
    setStack((s) => s.slice(0, -1));
  };
  const openSeason = (id: string): void => {
    forward(id === 'extras' ? '[data-testid="extras-row"]' : byAttr('data-season-id', id));
    setSeasonId(id);
  };
  const closeSeason = (): void => {
    backward();
    setSeasonId(null);
  };
  const openDisc = (disc: PreflightDisc, playlistId?: string): void => setSelected(playlistId === undefined ? { disc } : { disc, playlistId });

  if (settings) return <AdminScreen nas={nas} thisDeviceId={deviceId} onClose={() => setSettings(false)} />;

  if (selected) {
    return (
      <section className="titles" data-testid="title-library">
        <Preflight nas={nas} controller={controller} disc={selected.disc} playlistId={selected.playlistId} onFacts={() => {}} onCancel={() => setSelected(null)} />
      </section>
    );
  }

  if (openId !== null) {
    if (!detail) {
      return (
        <section className="titles" data-testid="title-library">
          <button type="button" className="title-back" aria-label="Back" onClick={back}>
            <span aria-hidden="true">‹</span>
          </button>
          {detailError ? (
            <div className="error-banner" role="alert" data-testid="nas-error">
              {detailError}
            </div>
          ) : (
            <p className="status">Loading…</p>
          )}
        </section>
      );
    }
    const season = seasonId === 'extras' ? extrasSeason(detail) : detail.seasons.find((s) => s.id === seasonId);
    if (season) {
      return <SeasonScreen seriesName={displayName(detail.title)} heading={seasonLabel(season)} season={season} onBack={closeSeason} onOpen={openDisc} />;
    }
    return <SeriesScreen nas={nas} detail={detail} onBack={back} onSeason={openSeason} onExtras={() => openSeason('extras')} onTitle={openTitle} onOpen={openDisc} />;
  }

  const counts: Record<Shelf, number | null> = {
    series: titles ? shelf(titles, 'series').length : null,
    movie: titles ? shelf(titles, 'movie').length : null,
    music: titles ? shelf(titles, 'music').length : null,
    unsorted,
  };
  const searching = query.trim() !== '';
  const results = titles && searching ? searchTitles(titles, query) : [];

  return (
    <section className="titles title-library" data-testid="title-library">
      <header className="titles-head">
        <h2>Library</h2>
        <div className="titles-actions">
          {owner && (
            <button type="button" className="title-icon-button" data-testid="nas-settings" aria-label="NAS settings" onClick={() => setSettings(true)}>
              <span aria-hidden="true">⚙</span>
            </button>
          )}
          <button type="button" className="title-icon-button" onClick={onClose}>
            Close
          </button>
        </div>
      </header>
      <input
        type="search"
        className="title-search"
        data-testid="title-search"
        placeholder="Search in English, romaji or Japanese"
        aria-label="Search titles"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="title-shelves" role="group" aria-label="Shelves">
        {SHELVES.filter((s) => s.id !== 'unsorted' || owner).map((s) => (
          <button
            key={s.id}
            type="button"
            className={`title-chip${picked === s.id ? ' selected' : ''}`}
            aria-pressed={picked === s.id}
            data-testid="title-shelf"
            data-shelf={s.id}
            onClick={() => setPicked((p) => (p === s.id ? null : s.id))}
          >
            {s.label}
            {counts[s.id] !== null && <span className="title-chip-count">{counts[s.id]}</span>}
          </button>
        ))}
      </div>
      {error && (
        <div className="error-banner" role="alert" data-testid="nas-error">
          {error}
        </div>
      )}
      {titles === null ? (
        !error && <p className="status">Loading…</p>
      ) : searching ? (
        results.length === 0 ? (
          <p className="status">No titles match “{query.trim()}”.</p>
        ) : (
          <ul className="title-list" data-testid="title-results">
            {results.map((t) => (
              <TitleRow key={t.id} nas={nas} title={t} onOpen={openTitle} />
            ))}
          </ul>
        )
      ) : picked === 'unsorted' ? (
        <p className="status" data-testid="title-unsorted">
          {unsorted === 1 ? '1 disc isn’t filed under a title yet.' : `${unsorted ?? 0} discs aren’t filed under a title yet.`}
        </p>
      ) : picked !== null ? (
        <>
          <h3 className="title-section">{SHELVES.find((s) => s.id === picked)!.label}</h3>
          {shelf(titles, picked).length === 0 ? (
            <p className="status">Nothing here yet.</p>
          ) : (
            <ul className="title-grid">
              {shelf(titles, picked).map((t) => (
                <TitleCard key={t.id} nas={nas} title={t} onOpen={openTitle} />
              ))}
            </ul>
          )}
        </>
      ) : titles.length === 0 ? (
        <p className="status">No titles yet. The NAS files discs under titles after each scan.</p>
      ) : (
        <>
          <h3 className="title-section">Recently added</h3>
          <ul className="title-grid">
            {recentlyAdded(titles).map((t) => (
              <TitleCard key={t.id} nas={nas} title={t} onOpen={openTitle} />
            ))}
          </ul>
          {counts.series! > 0 && (
            <>
              <h3 className="title-section">Series A–Z</h3>
              <ul className="title-list">
                {shelf(titles, 'series').map((t) => (
                  <TitleRow key={t.id} nas={nas} title={t} onOpen={openTitle} />
                ))}
              </ul>
            </>
          )}
        </>
      )}
      <button type="button" className="title-link" data-testid="browse-folders" onClick={onFolders}>
        Browse by folder instead
      </button>
    </section>
  );
}
