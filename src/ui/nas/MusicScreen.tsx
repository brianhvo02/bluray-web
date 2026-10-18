import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import type { TitleDetail, TitleSummary } from '../../engine/disc/nas-api';
import type { NasClient } from './nas-client';
import { displayName } from './title-model';

interface MusicScreenProps {
  readonly nas: NasClient;
  /** The Music shelf's titles, A–Z. */
  readonly titles: readonly TitleSummary[];
  /** Owners can rename. */
  readonly owner: boolean;
  readonly onOpen: (id: string) => void;
  /** A title's detail, from the library's session cache: where its first disc is. */
  readonly loadDetail: (id: string) => Promise<TitleDetail>;
  /** A rename changed the catalogue: the library fetches its titles again. */
  readonly onChanged: () => void;
}

const MAX_NAME = 200;
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Where a music title's first disc is: `drive · folder`. */
function firstCopy(d: TitleDetail): string | null {
  const slot = [...d.seasons.flatMap((s) => s.discs), ...d.extras][0];
  const copy = slot?.copies[0];
  return copy ? `${copy.root} · ${copy.folder}` : null;
}

/** The row's muted line: the folder name a rename replaced, else where the title's discs are (loaded once near view). */
function MusicPlace({ title, loadDetail }: { title: TitleSummary; loadDetail: (id: string) => Promise<TitleDetail> }): ReactElement | null {
  const renamed = !title.own && title.names.display !== null && title.names.english !== null && title.names.display !== title.names.english;
  const [place, setPlace] = useState<string | null>(null);
  const [near, setNear] = useState(false);
  const holder = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (renamed || title.own || near) return;
    const el = holder.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), { rootMargin: '200px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [renamed, title.own, near]);

  useEffect(() => {
    if (!near) return;
    let live = true;
    loadDetail(title.id).then(
      (d) => {
        if (live) setPlace(firstCopy(d));
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [near, title.id, loadDetail]);

  if (renamed) return <span className="title-muted">Renamed · was {title.names.english}</span>;
  if (title.own) return <span className="title-muted">Own title</span>;
  return (
    <span ref={holder} className="title-muted">
      {place ?? ' '}
    </span>
  );
}

function RenameForm({ nas, title, onDone, onCancel }: { nas: NasClient; title: TitleSummary; onDone: () => void; onCancel: () => void }): ReactElement {
  const [name, setName] = useState(displayName(title));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const save = (value: string | null): void => {
    setBusy(true);
    setError(null);
    // an own title's name is the title's; any other music title's is a display name over its folder name
    const done = title.own ? nas.admin.updateTitle(title.id, { name: value! }) : nas.admin.setName(title.id, value);
    done.then(
      () => {
        setBusy(false);
        onDone();
      },
      (err: unknown) => {
        setBusy(false);
        setError(message(err));
      },
    );
  };
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed === '') {
      if (title.own) setError('Give the title a name.');
      else save(null);
      return;
    }
    save(trimmed);
  };

  return (
    <form className="owner-form" data-testid="music-rename-form" onSubmit={submit}>
      <label className="owner-field">
        <span>Display name</span>
        <input ref={input} type="text" data-testid="music-name" value={name} maxLength={MAX_NAME} onChange={(e) => setName(e.target.value)} />
      </label>
      {error && (
        <p className="owner-message" role="alert">
          {error}
        </p>
      )}
      <div className="owner-buttons">
        {!title.own && (
          <button type="button" data-testid="music-folder-name" disabled={busy} onClick={() => save(null)}>
            Use folder name
          </button>
        )}
        <button type="submit" className="owner-primary" data-testid="music-save" disabled={busy}>
          Save
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The Music shelf (spec §9, mockup 5): each title with where it is or what it was renamed from, and owners' renames. */
export function MusicScreen({ nas, titles, owner, onOpen, loadDetail, onChanged }: MusicScreenProps): ReactElement {
  const [editing, setEditing] = useState<string | null>(null);
  /** After a rename is saved or cancelled, focus goes back to that row's pencil. */
  const focusPencil = useRef<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (focusPencil.current === null) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-rename-id="${CSS.escape(focusPencil.current)}"]`);
    if (!el) return;
    focusPencil.current = null;
    el.focus();
  });
  const closeEditor = (id: string): void => {
    focusPencil.current = id;
    setEditing(null);
  };
  if (titles.length === 0) return <p className="status">Nothing here yet.</p>;
  return (
    <ul className="title-list" data-testid="music-list" ref={listRef}>
      {titles.map((t) => {
        const name = displayName(t);
        return (
          <li key={t.id} className="owner-row" data-testid="music-row" data-name={name}>
            <div className="owner-row-main">
              <button type="button" className="title-row" data-title-id={t.id} onClick={() => onOpen(t.id)}>
                <span className="title-row-text">
                  <span className="title-row-name">{name}</span>
                  <MusicPlace title={t} loadDetail={loadDetail} />
                </span>
              </button>
              {owner && (
                <button
                  type="button"
                  className="title-icon-button"
                  data-testid="music-rename"
                  data-rename-id={t.id}
                  aria-label={`Rename ${name}`}
                  aria-expanded={editing === t.id}
                  onClick={() => setEditing((e) => (e === t.id ? null : t.id))}
                >
                  <span aria-hidden="true">✎</span>
                </button>
              )}
            </div>
            {editing === t.id && (
              <RenameForm
                nas={nas}
                title={t}
                onCancel={() => closeEditor(t.id)}
                onDone={() => {
                  closeEditor(t.id);
                  onChanged();
                }}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}
