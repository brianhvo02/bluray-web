import { useEffect, useState, type ReactElement } from 'react';
import { NasHttpError, type NasClient, type NasRelaySettings } from './nas-client';
import { relaySettingsCopy, usageLine } from './relay-model';

/**
 * The Cloudflare relay's part of NAS settings (spec §6.4): an on/off switch, the switch for paid use beyond the free
 * allowance, and the month's usage. Absent when the NAS has no relay (its route answers 404).
 */
export function RelaySettings({ nas }: { nas: NasClient }): ReactElement | null {
  const [settings, setSettings] = useState<NasRelaySettings | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    nas.admin.relay().then(
      (s) => live && setSettings(s),
      (err: unknown) => {
        if (!live) return;
        if (err instanceof NasHttpError && err.status === 404) setMissing(true);
        else setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      live = false;
    };
  }, [nas]);

  const change = (patch: { enabled?: boolean; allowPaid?: boolean }): void => {
    setBusy(true);
    setError(null);
    nas.admin.setRelay(patch).then(
      (s) => {
        setSettings(s);
        setBusy(false);
      },
      (err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      },
    );
  };

  if (missing) return null;
  return (
    <section className="admin-relay" data-testid="nas-relay-settings" aria-labelledby="admin-relay-head">
      <h3 id="admin-relay-head">{relaySettingsCopy.heading}</h3>
      {settings && (
        <>
          <label className="admin-switch">
            <input type="checkbox" role="switch" data-testid="nas-relay-enabled" checked={settings.enabled} disabled={busy} onChange={(e) => change({ enabled: e.target.checked })} />{' '}
            {relaySettingsCopy.enable}
          </label>
          <label className="admin-switch">
            <input type="checkbox" role="switch" data-testid="nas-relay-paid" checked={settings.allowPaid} disabled={busy} onChange={(e) => change({ allowPaid: e.target.checked })} />{' '}
            {relaySettingsCopy.allowPaid}
          </label>
          {settings.allowPaid && <p className="status">{relaySettingsCopy.paidWarning}</p>}
          <p className="status" data-testid="nas-relay-usage">
            {usageLine(settings.usage)}
          </p>
          <p className="status">{relaySettingsCopy.terms}</p>
        </>
      )}
      {error && (
        <p role="alert" data-testid="nas-relay-error">
          {error}
        </p>
      )}
    </section>
  );
}
