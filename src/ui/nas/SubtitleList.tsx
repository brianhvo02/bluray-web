import { useCallback, useEffect, useId, useMemo, useState, type ReactElement } from 'react';
import type { DiscManifest, StoredSubtitle } from '../../engine/disc/nas-api';
import { discKeyOf } from '../../engine/disc/disc-key';
import type { NasClient } from './nas-client';
import { LANGUAGES, formatOffset, languageTag, subtitleErrorMessage, type SubtitleTarget } from './subtitle-model';
import { SubtitleUpload, type ManifestOf } from './SubtitleUpload';

/** A title's stored subtitles (null until known, or when this device may not see them), and a way to fetch them again. */
export function useStoredSubtitles(nas: Pick<NasClient, 'subtitlesForTitle'>, titleId: string, enabled: boolean): { readonly subs: readonly StoredSubtitle[] | null; readonly reload: () => void } {
  const [subs, setSubs] = useState<readonly StoredSubtitle[] | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    nas.subtitlesForTitle(titleId).then(
      (s) => live && setSubs(s),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [nas, titleId, enabled, version]);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { subs, reload };
}

/** Disc manifests, each fetched once while the screen is open (a failed fetch is tried again next time). */
export function useManifests(nas: Pick<NasClient, 'manifest'> | null): ManifestOf {
  return useMemo(() => {
    const cache = new Map<string, Promise<DiscManifest>>();
    return (discId: string) => {
      if (!nas) return Promise.reject(new Error('Only owners read disc manifests here.'));
      let p = cache.get(discId);
      if (!p) {
        p = nas.manifest(discId);
        cache.set(discId, p);
        p.catch(() => cache.delete(discId));
      }
      return p;
    };
  }, [nas]);
}

/**
 * Disc key → disc id for the target's discs, from their manifests; fetched only when `needed` (an upload attached to a
 * chapter has only its disc key), empty until then.
 */
export function useDiscKeys(manifestOf: ManifestOf, target: SubtitleTarget, needed: boolean): ReadonlyMap<string, string> {
  const [keys, setKeys] = useState<ReadonlyMap<string, string>>(new Map());
  const discIds = target.discs.map((d) => d.discId).join(',');
  useEffect(() => {
    if (!needed || discIds === '') return;
    let live = true;
    void Promise.all(
      discIds.split(',').map((id) =>
        manifestOf(id).then(
          (m): [string, string] | null => [discKeyOf(id, m.files), id],
          () => null,
        ),
      ),
    ).then((pairs) => live && setKeys(new Map(pairs.filter((p) => p !== null))));
    return () => {
      live = false;
    };
  }, [manifestOf, discIds, needed]);
  return keys;
}

const languageName = (code: string): string | null => LANGUAGES.find((l) => l.code.toLowerCase() === code.toLowerCase())?.label ?? null;

function attachmentLabel(s: StoredSubtitle, target: SubtitleTarget, keys: ReadonlyMap<string, string>): string {
  const a = s.attachment;
  if (a.kind === 'episode') return `Episode ${a.episode}`;
  const discId = keys.get(a.discKey);
  const disc = target.discs.find((d) => d.discId === discId)?.label ?? 'A disc';
  return `${disc} · playlist ${a.playlistId} · chapter ${a.chapter + 1}`;
}

interface SubtitleListProps {
  readonly nas: NasClient;
  readonly target: SubtitleTarget;
  /** The uploads this screen lists. */
  readonly subs: readonly StoredSubtitle[];
  readonly manifestOf: ManifestOf;
  /** Disc key → disc id for the target's discs (useDiscKeys). */
  readonly discKeys: ReadonlyMap<string, string>;
  /** An upload changed or went: the screen fetches the subtitles again. */
  readonly onChanged: () => void;
}

/**
 * The owner's list of a season's or movie's uploads: name, language, what it is for (marked "Not attached" when its disc
 * or playlist is gone), its files and default offset, with Edit (the upload form, filled in) and Delete after a confirm.
 */
export function SubtitleList({ nas, target, subs, manifestOf, discKeys, onChanged }: SubtitleListProps): ReactElement {
  const [open, setOpen] = useState<{ readonly id: string; readonly what: 'edit' | 'delete' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ readonly id: string; readonly message: string } | null>(null);
  const discIdOfKey = useCallback((key: string) => discKeys.get(key) ?? null, [discKeys]);
  const heading = useId();

  const remove = async (id: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await nas.deleteSubtitle(id);
      setOpen(null);
      onChanged();
    } catch (err) {
      setError({ id, message: subtitleErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="subtitle-section" data-testid="subtitle-list" aria-labelledby={heading}>
      <h3 className="title-section" id={heading}>
        Subtitles on the NAS
      </h3>
      {subs.length === 0 ? (
        <p className="title-muted subtitle-empty">None uploaded yet.</p>
      ) : (
        <ul className="title-list">
          {subs.map((s) => {
            const offset = formatOffset(s.offsetMs);
            const language = languageName(s.language);
            const what = open?.id === s.id ? open.what : null;
            return (
              <li key={s.id} className="subtitle-row" data-testid="subtitle-row" data-name={s.name} data-id={s.id}>
                <div className="subtitle-row-main">
                  <span className="tag" title={s.language}>
                    {languageTag(s.language)}
                  </span>
                  <span className="title-row-text">
                    <span className="title-row-name">{s.name}</span>
                    <span className="title-muted">
                      {[attachmentLabel(s, target, discKeys), language ?? s.language].join(' · ')}
                      {s.attached === false && (
                        <span className="subtitle-not-attached" data-testid="subtitle-not-attached">
                          Not attached
                        </span>
                      )}
                    </span>
                    <span className="title-muted subtitle-files">{[[s.fileName, ...s.fonts.map((f) => f.name)].join(', '), offset].filter((x) => x !== null).join(' · ')}</span>
                  </span>
                  <span className="admin-confirm">
                    <button type="button" data-testid="subtitle-edit" aria-expanded={what === 'edit'} aria-label={`Edit ${s.name}`} disabled={busy} onClick={() => setOpen(what === 'edit' ? null : { id: s.id, what: 'edit' })}>
                      Edit
                    </button>
                    <button type="button" data-testid="subtitle-delete" aria-label={`Delete ${s.name}`} disabled={busy} onClick={() => setOpen({ id: s.id, what: 'delete' })}>
                      Delete
                    </button>
                  </span>
                </div>
                {what === 'edit' && (
                  <SubtitleUpload
                    nas={nas}
                    target={target}
                    manifestOf={manifestOf}
                    editing={s}
                    discIdOfKey={discIdOfKey}
                    onDone={() => {
                      setOpen(null);
                      onChanged();
                    }}
                    onCancel={() => setOpen(null)}
                  />
                )}
                {what === 'delete' && (
                  <div className="admin-confirm-box" role="group" aria-label="Confirm">
                    <p>{`Delete ${s.name} and its fonts from the NAS? Everyone loses it.`}</p>
                    <span className="admin-confirm">
                      <button type="button" data-testid="subtitle-delete-confirm" disabled={busy} onClick={() => void remove(s.id)}>
                        Delete
                      </button>
                      <button type="button" disabled={busy} onClick={() => setOpen(null)}>
                        Cancel
                      </button>
                    </span>
                  </div>
                )}
                {error?.id === s.id && (
                  <p className="owner-message" role="alert">
                    {error.message}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
