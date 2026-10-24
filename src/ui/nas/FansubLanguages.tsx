import { useEffect, useState, type ReactElement } from 'react';
import { FANSUB_LANGUAGES } from './fansub-model';
import type { NasClient } from './nas-client';

/** Admin: which languages fansub runs keep besides English. Saved as each box is ticked. */
export function FansubLanguages({ nas }: { nas: Pick<NasClient, 'fansubLanguages' | 'setFansubLanguages'> }): ReactElement | null {
  const [codes, setCodes] = useState<readonly string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    nas.fansubLanguages().then((c) => live && setCodes(c), () => {}); // a NAS without fansubs has no setting to show
    return () => {
      live = false;
    };
  }, [nas]);
  if (codes === null) return null;
  const toggle = (code: string, on: boolean): void => {
    setBusy(true);
    setError(null);
    nas.setFansubLanguages(on ? [...codes, code] : codes.filter((c) => c !== code)).then(
      (saved) => {
        setCodes(saved);
        setBusy(false);
      },
      () => {
        setError("Couldn't save the languages.");
        setBusy(false);
      },
    );
  };
  return (
    <section className="fansub-languages" data-testid="fansub-languages" aria-labelledby="fansub-languages-head">
      <h3 id="fansub-languages-head">Fansub languages</h3>
      <p className="title-muted">Fansub runs keep these subtitle languages.</p>
      <label><input type="checkbox" checked disabled /> English</label>
      {FANSUB_LANGUAGES.map((l) => (
        <label key={l.code}>
          <input type="checkbox" data-testid={`fansub-language-${l.code}`} checked={codes.includes(l.code)} disabled={busy} onChange={(e) => toggle(l.code, e.target.checked)} /> {l.label}
        </label>
      ))}
      {error !== null && <p className="owner-message" role="alert">{error}</p>}
    </section>
  );
}
