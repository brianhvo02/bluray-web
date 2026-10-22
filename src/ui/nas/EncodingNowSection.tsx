import { useEffect, useState, type ReactElement } from 'react';
import type { EncodingNow } from '../../engine/disc/nas-api';
import { encodingLine } from './admin-model';
import type { NasClient } from './nas-client';

/** While the section shows, what is encoding is asked again this often. */
export const ENCODING_POLL_MS = 10_000;

/**
 * "Encoding now" (spec §6.4): what the NAS GPU is re-encoding and for whom, refreshed when the screen opens and every
 * 10 s. Hidden when the NAS has no quality levels (its route answers 404); a failed refresh keeps the last list.
 */
export function EncodingNowSection({ nas }: { nas: NasClient }): ReactElement | null {
  const [list, setList] = useState<readonly EncodingNow[] | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let live = true;
    const load = (): void => {
      nas.admin.encodingNow().then(
        (l) => {
          if (!live) return;
          if (l === null) setMissing(true);
          else setList(l);
        },
        () => {},
      );
    };
    load();
    const timer = setInterval(load, ENCODING_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [nas]);

  if (missing) return null;
  return (
    <section className="admin-encoding" data-testid="encoding-now" aria-labelledby="admin-encoding-head">
      <h3 id="admin-encoding-head">Encoding now</h3>
      {list === null ? (
        <p className="status">Loading…</p>
      ) : list.length === 0 ? (
        <p className="status">Nothing is being re-encoded.</p>
      ) : (
        <ul className="library-rows">
          {list.map((e, i) => (
            <li key={i} data-testid="encoding-row">
              {encodingLine(e)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
