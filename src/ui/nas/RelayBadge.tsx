import { useEffect, useState, type ReactElement } from 'react';
import type { NasClient } from './nas-client';
import { RELAYED_BADGE, usageLine } from './relay-model';

/** How often the route and the usage are looked at again while a NAS disc is open. */
const REFRESH_MS = 30_000;

/**
 * While a NAS disc plays over a relayed connection: a small "Relayed" badge, and the month's usage (from `me`) as its
 * tooltip and beside it. Nothing otherwise.
 */
export function RelayBadge({ nas }: { nas: NasClient }): ReactElement | null {
  const [relayed, setRelayed] = useState(false);
  const [usage, setUsage] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const look = (): void => {
      const isRelayed = nas.currentRoute() === 'relay';
      setRelayed(isRelayed);
      if (!isRelayed) return;
      nas.me().then(
        (me) => live && setUsage(me.relay ? usageLine(me.relay) : null),
        () => undefined,
      );
    };
    look();
    const timer = setInterval(look, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [nas]);

  if (!relayed) return null;
  return (
    <div className="relay-badge" data-testid="relay-badge">
      <span className="badge">{RELAYED_BADGE}</span>
      {usage && (
        <span className="status" data-testid="relay-usage">
          {' '}
          {usage}
        </span>
      )}
    </div>
  );
}
