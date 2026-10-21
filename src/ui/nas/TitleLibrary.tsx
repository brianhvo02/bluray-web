import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { SeasonDetail, TitleDetail, TitleKind, TitleSummary } from '../../engine/disc/nas-api';
import type { PlayerController } from '../../player/player-controller';
import { AdminScreen } from './AdminScreen';
import { HiddenScreen } from './HiddenScreen';
import { rememberedFolder } from './LibraryScreen';
import { MusicScreen } from './MusicScreen';
import { NasHttpError, type NasClient } from './nas-client';
import { useNasRoute, type NasHistory } from './nas-history';
import { nasRoutePath, seasonIdOf, seasonKeyOf, type NasRoute } from './nas-route';
import { Poster } from './Poster';
import { Preflight, type PreflightDisc } from './Preflight';
import { SeasonScreen } from './SeasonScreen';
import { SeriesScreen } from './SeriesScreen';
import type { OwnerFiling } from './FileDifferently';
import { displayName, emptyLibraryText, recentlyAdded, searchTitles, seasonLabel, secondaryName, shelf } from './title-model';
import { UnsortedScreen } from './UnsortedScreen';

interface TitleLibraryProps {
  readonly nas: NasClient;
  readonly controller: PlayerController;
  /** The screen shown is the address bar's route; every move goes through it. */
  readonly history: NasHistory;
  /** From `GET me`: owners get the settings and the Unsorted shelf. */
  readonly owner: boolean;
  /** This device is no longer an owner (the NAS refused the settings): the caller asks `me` again. */
  readonly onOwnerLost?: () => void;
  /** The title routes answered 404 to this guest (the gate closed since `me` answered): the caller shows the folders. */
  readonly onGateClosed: () => void;
  readonly onClose: () => void;
}

type Shelf = TitleKind | 'unsorted';

const LIBRARY: NasRoute = { kind: 'library', shelf: null, q: '' };
const HEADING = '[data-focus-heading]';
/** The search goes into the address bar this long after the last keystroke. */
const SEARCH_WRITE_DELAY_MS = 300;
const byAttr = (name: string, value: string): string => `[${name}="${CSS.escape(value)}"]`;

/** The item on the screen below `route` that opens it, which takes focus when going back from it. */
function openerOf(route: NasRoute): string | null {
  switch (route.kind) {
    case 'title':
      return byAttr('data-title-id', route.titleId);
    case 'season':
      return byAttr('data-season-id', seasonIdOf(route.titleId, route.seasonKey));
    case 'extras':
      return '[data-testid="extras-row"]';
    case 'unsorted':
      return '[data-shelf="unsorted"]';
    case 'hidden':
      return '[data-testid="open-hidden"]';
    case 'settings':
      return '[data-testid="nas-settings"]';
    default:
      return null;
  }
}

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
/** After an owner change: the titles and their details are fetched again. */
const forgetTitles = (nas: NasClient): void => {
  const c = cacheOf(nas);
  c.titles = undefined;
  c.details.clear();
};

/** While the first matching run fills an empty library, owners see its progress refreshed this often (ruling F4). */
const PROGRESS_POLL_MS = 10_000;

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
export function TitleLibrary({ nas, controller, history, owner, onOwnerLost, onGateClosed, onClose }: TitleLibraryProps): ReactElement {
  const routed = useNasRoute(history);
  // A play route has no screen of its own yet: the library, with the address bar left as it is.
  const route: NasRoute = routed === null || routed.kind === 'play' || routed.kind === 'folders' ? LIBRARY : routed;
  const routeKey = nasRoutePath(route);
  const query = route.kind === 'library' ? route.q : '';
  /**
   * The search field's text. The route takes it 300 ms after the last keystroke, or when the field loses focus: Safari
   * refuses more than about 100 history changes in 30 s, so not every keystroke can be one.
   */
  const [draft, setDraft] = useState(query);
  useEffect(() => setDraft(query), [query]);
  const searchTimer = useRef<number | null>(null);
  const cancelSearchWrite = (): void => {
    if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    searchTimer.current = null;
  };
  useEffect(() => cancelSearchWrite, []);
  /** Puts `q` in the address bar, if the library is still the screen shown. */
  const writeSearch = (q: string, shelf: TitleKind | null): void => {
    cancelSearchWrite();
    if (history.route()?.kind === 'library') history.replace({ kind: 'library', shelf, q });
  };
  const picked = route.kind === 'library' ? route.shelf : null;
  /** The open title, and its open season, or 'extras' for its own extras. */
  const openId = route.kind === 'title' || route.kind === 'season' || route.kind === 'extras' ? route.titleId : null;
  const seasonKey = route.kind === 'season' ? route.seasonKey : route.kind === 'extras' ? 'extras' : null;
  const ownerOnly = route.kind === 'unsorted' || route.kind === 'hidden' || route.kind === 'settings';
  const [titles, setTitles] = useState<TitleSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unsorted, setUnsorted] = useState<number | null>(null);
  /** Whether the NAS has a TMDB key (owners' searches skip TMDB without one). */
  const [tmdb, setTmdb] = useState(false);
  /** The matching run's progress, for an owner's empty library (ruling F4). */
  const [progress, setProgress] = useState<{ running: boolean; groupsDone: number; groupsTotal: number; filed: number; music: number } | null>(null);
  /** Bumped after an owner change, so the titles and the Unsorted count are fetched again. */
  const [version, setVersion] = useState(0);
  /** The open title's detail, with the id it was fetched for. */
  const [loaded, setLoaded] = useState<{ id: string; detail: TitleDetail } | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  /** An owner's title that answered 404 (its last disc filed differently): its screens are left, back to the library. */
  const [gone, setGone] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ disc: PreflightDisc; playlistId?: string } | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);

  // The owner screens are an owner's: anyone else on their paths gets the library.
  useEffect(() => {
    if (ownerOnly && !owner) history.replace(LIBRARY);
  }, [ownerOnly, owner, history]);

  useEffect(() => {
    let live = true;
    loadTitles(nas).then(
      (list) => {
        if (live) {
          setTitles(list);
          setError(null);
        }
      },
      (err: unknown) => {
        if (!live) return;
        // The gate closed since `me` answered: the folder browser, as for any guest.
        if (isGateClosed(err)) onGateClosed();
        else setError(message(err));
      },
    );
    return () => {
      live = false;
    };
  }, [nas, onGateClosed, version]);

  useEffect(() => {
    if (!owner) return;
    let live = true;
    nas.admin.titleStatus().then(
      (s) => {
        if (!live) return;
        setUnsorted(s.unsorted);
        setTmdb(s.tmdb);
        setProgress(s);
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
  }, [nas, owner, version]);

  const changed = useCallback(() => {
    forgetTitles(nas);
    // A title that went may be back after this change.
    setGone(null);
    setVersion((v) => v + 1);
  }, [nas]);

  // An empty library while the first run matches: its progress is asked again every so often, and the titles once
  // the run has published some (it does at each checkpoint)
  const empty = titles !== null && titles.length === 0;
  useEffect(() => {
    if (!owner || !empty || !progress?.running) return;
    const timer = setInterval(() => {
      nas.admin.titleStatus().then(
        (s) => {
          if (s.filed + s.music > 0 || !s.running) changed();
          else setProgress(s);
        },
        () => {},
      );
    }, PROGRESS_POLL_MS);
    return () => clearInterval(timer);
  }, [nas, owner, empty, progress?.running, changed]);
  const loadDetail = useCallback((id: string) => loadTitle(nas, id), [nas]);

  useEffect(() => {
    setLoaded(null);
    setDetailError(null);
    if (openId === null) return;
    let live = true;
    loadTitle(nas, openId).then(
      (d) => {
        if (!live) return;
        setLoaded({ id: openId, detail: d });
        // Filed again since it went: it opens.
        setGone((g) => (g === openId ? null : g));
      },
      (err: unknown) => {
        if (!live) return;
        if (isGateClosed(err)) {
          // An owner's title is gone, its last disc filed differently (ruling F3): back to where it was opened from.
          if (owner) setGone(openId);
          // As for the list: the gate closed meanwhile, so the folder browser, with no raw error.
          else onGateClosed();
        } else setDetailError(message(err));
      },
    );
    return () => {
      live = false;
    };
  }, [nas, openId, onGateClosed, version, owner]);
  useEffect(() => {
    if (openId !== null && openId === gone) history.back(LIBRARY);
  }, [routeKey, openId, gone, history]);
  const detail = loaded !== null && loaded.id === openId && openId !== gone ? loaded.detail : null;

  // A pre-flight belongs to the screen it was opened on: any move (Back, Forward) closes it.
  useEffect(() => setSelected(null), [routeKey]);

  /**
   * Focus follows the screens: a screen opened in the app focuses its heading, and going back focuses the item that
   * opened the screen left (the button that had focus is gone with its screen); going forward through the browser's
   * history focuses the heading. `focusNext` holds the selectors to try, applied once one of them renders.
   */
  const shownRoute = useRef(route);
  const focusNext = useRef<string[] | null>(null);
  useEffect(() => {
    const from = shownRoute.current;
    shownRoute.current = route;
    if (nasRoutePath(from) === routeKey) return;
    const move = history.lastMove();
    const opener = openerOf(from);
    if (move === 'push') focusNext.current = route.kind === 'library' ? null : [HEADING];
    else if (move === 'pop') focusNext.current = opener ? [opener, HEADING] : [HEADING];
    else focusNext.current = opener ? [opener] : null;
  }, [routeKey, history]); // `route` is a new object each render; `routeKey` is its identity
  useEffect(() => {
    const next = focusNext.current;
    if (next === null) return;
    for (const selector of next) {
      const el = document.querySelector<HTMLElement>(selector);
      if (el) {
        focusNext.current = null;
        el.focus();
        return;
      }
    }
    // not rendered yet (a title still loading)
  });

  const openTitle = useCallback((id: string) => history.push({ kind: 'title', titleId: id }), [history]);
  const back = (): void => history.back(LIBRARY);
  const openSeason = (id: string): void => {
    if (openId === null) return;
    history.push(id === 'extras' ? { kind: 'extras', titleId: openId } : { kind: 'season', titleId: openId, seasonKey: seasonKeyOf(id) });
  };
  const closeSeason = (): void => {
    if (openId !== null) history.back({ kind: 'title', titleId: openId });
  };
  const openDisc = (disc: PreflightDisc, playlistId?: string): void => setSelected(playlistId === undefined ? { disc } : { disc, playlistId });
  const filing: OwnerFiling | undefined = owner ? { nas, tmdb, onChanged: changed } : undefined;

  if (owner && route.kind === 'settings') {
    return (
      <AdminScreen
        nas={nas}
        thisDeviceId={deviceId}
        onClose={() => history.back(LIBRARY)}
        onAccessLost={() => {
          history.back(LIBRARY);
          onOwnerLost?.();
        }}
        onTitlesChanged={changed}
      />
    );
  }

  if (owner && route.kind === 'hidden') {
    return <HiddenScreen nas={nas} tmdb={tmdb} onBack={() => history.back({ kind: 'unsorted' })} onChanged={changed} />;
  }
  if (owner && route.kind === 'unsorted') {
    return <UnsortedScreen nas={nas} tmdb={tmdb} onBack={() => history.back(LIBRARY)} onHidden={() => history.push({ kind: 'hidden' })} onChanged={changed} />;
  }

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
    const season = seasonKey === 'extras' ? extrasSeason(detail) : detail.seasons.find((s) => seasonKey !== null && seasonKeyOf(s.id) === seasonKey);
    if (season) {
      return <SeasonScreen seriesName={displayName(detail.title)} heading={seasonLabel(season)} season={season} onBack={closeSeason} onOpen={openDisc} owner={filing} />;
    }
    return <SeriesScreen nas={nas} detail={detail} onBack={back} onSeason={openSeason} onExtras={() => openSeason('extras')} onTitle={openTitle} onOpen={openDisc} owner={filing} />;
  }

  const counts: Record<Shelf, number | null> = {
    series: titles ? shelf(titles, 'series').length : null,
    movie: titles ? shelf(titles, 'movie').length : null,
    music: titles ? shelf(titles, 'music').length : null,
    unsorted,
  };
  const searching = draft.trim() !== '';
  const results = titles && searching ? searchTitles(titles, draft) : [];

  return (
    <section className="titles title-library" data-testid="title-library">
      <header className="titles-head">
        <h2>Library</h2>
        <div className="titles-actions">
          {owner && (
            <button type="button" className="title-icon-button" data-testid="nas-settings" aria-label="NAS settings" onClick={() => history.push({ kind: 'settings' })}>
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
        value={draft}
        // The shelf stays picked under a search, as before paths: clearing the search shows it again.
        onChange={(e) => {
          const q = e.target.value;
          setDraft(q);
          cancelSearchWrite();
          searchTimer.current = window.setTimeout(() => writeSearch(q, picked), SEARCH_WRITE_DELAY_MS);
        }}
        onBlur={() => {
          if (searchTimer.current !== null) writeSearch(draft, picked);
        }}
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
            onClick={() => {
              const id = s.id;
              if (id === 'unsorted') history.push({ kind: 'unsorted' });
              else {
                cancelSearchWrite();
                history.push({ kind: 'library', shelf: picked === id ? null : id, q: draft });
              }
            }}
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
          <p className="status">No titles match “{draft.trim()}”.</p>
        ) : (
          <ul className="title-list" data-testid="title-results">
            {results.map((t) => (
              <TitleRow key={t.id} nas={nas} title={t} onOpen={openTitle} />
            ))}
          </ul>
        )
      ) : picked === 'music' ? (
        <>
          <h3 className="title-section">Music</h3>
          <MusicScreen nas={nas} titles={shelf(titles, 'music')} owner={owner} tmdb={tmdb} onOpen={openTitle} loadDetail={loadDetail} onChanged={changed} />
        </>
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
        <p className="status" data-testid="library-empty">
          {emptyLibraryText(owner, progress)}
        </p>
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
      <button type="button" className="title-link" data-testid="browse-folders" onClick={() => history.push({ kind: 'folders', path: rememberedFolder() })}>
        Browse by folder instead
      </button>
    </section>
  );
}
