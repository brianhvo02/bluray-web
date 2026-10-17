import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { countdown, deviceRow, newCode, revoke } from './admin-model';
import type { NasClient, NasDevice } from './nas-client';
import { qrSvg } from './qr';

interface AdminScreenProps {
  readonly nas: NasClient;
  /** This device's id, to mark its row; null when it isn't known. */
  readonly thisDeviceId: string | null;
  readonly onClose: () => void;
  /** The clock for the countdown and the last-seen times. */
  readonly now?: () => number;
}

/** While a code is shown, the devices list is reloaded this often, so the device that redeems it turns up. */
const DEVICE_POLL_MS = 3_000;

interface ShownCode {
  readonly code: string;
  readonly link: string;
  readonly expiresAt: number;
  readonly qr: { size: number; path: string };
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** NAS settings, for owners: a new pairing code with its QR and countdown, the paired devices with Revoke, and Rescan. */
export function AdminScreen({ nas, thisDeviceId, onClose, now = Date.now }: AdminScreenProps): ReactElement {
  const [devices, setDevices] = useState<NasDevice[] | null>(null);
  const [owner, setOwner] = useState(false);
  const [code, setCode] = useState<ShownCode | null>(null);
  const [copied, setCopied] = useState(false);
  const [minting, setMinting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);

  const loadDevices = useCallback((): Promise<void> => nas.admin.devices().then(setDevices, (err: unknown) => setError(message(err))), [nas]);
  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  const live = code !== null && now() < code.expiresAt;
  useEffect(() => {
    if (!live) return;
    const tick = window.setInterval(() => setTick((t) => t + 1), 1_000);
    const poll = window.setInterval(() => void loadDevices(), DEVICE_POLL_MS);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(poll);
    };
  }, [live, loadDevices]);

  const onNewCode = (): void => {
    setError(null);
    setMinting(true);
    newCode(nas.admin, owner).then(
      (minted) => {
        setCode({ ...minted, qr: qrSvg(minted.link) });
        setCopied(false);
        setMinting(false);
      },
      (err: unknown) => {
        setError(message(err));
        setMinting(false);
      },
    );
  };

  const onCopy = (): void => {
    if (!code) return;
    navigator.clipboard.writeText(code.code).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  const onRevoke = (id: string): void => {
    setError(null);
    void revoke(nas.admin, id).then((failed) => {
      if (failed) {
        setError(failed);
        return;
      }
      setDevices((list) => list?.filter((d) => d.id !== id) ?? null);
      void loadDevices();
    });
  };

  const onRescan = (): void => {
    setError(null);
    nas.admin.rescan().then(
      () => setStatus('Rescanning…'),
      (err: unknown) => setError(message(err)),
    );
  };

  const at = now();

  return (
    <section className="library admin" data-testid="nas-admin">
      <div className="library-head">
        <h2>NAS settings</h2>
        <button type="button" onClick={onClose}>
          Back
        </button>
      </div>
      <div className="admin-new-code">
        <button type="button" data-testid="nas-new-code" onClick={onNewCode} disabled={minting}>
          New pairing code
        </button>
        <label className="admin-owner">
          <input type="checkbox" data-testid="nas-owner-code" checked={owner} onChange={(e) => setOwner(e.target.checked)} /> Owner
        </label>
      </div>
      {code && (
        <div className="admin-code">
          <svg
            data-testid="nas-code-qr"
            className="admin-qr"
            role="img"
            aria-label="QR code of the pairing link"
            viewBox={`0 0 ${code.qr.size} ${code.qr.size}`}
            shapeRendering="crispEdges"
          >
            <rect width={code.qr.size} height={code.qr.size} fill="#fff" />
            <path d={code.qr.path} fill="#000" />
          </svg>
          <p>
            <code className="admin-code-text" data-testid="nas-code">
              {code.code}
            </code>{' '}
            <button type="button" data-testid="nas-code-copy" onClick={onCopy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </p>
          <p className="status" data-testid="nas-code-expiry">
            {countdown(code.expiresAt, at)}
          </p>
        </div>
      )}
      <h3>Devices</h3>
      {devices === null ? (
        !error && <p className="status">Loading…</p>
      ) : (
        <ul className="library-rows">
          {devices.map((d) => {
            const row = deviceRow(d, at, thisDeviceId);
            return (
              <li key={row.id} className="admin-device" data-testid="nas-device" data-device-id={row.id}>
                <span className="library-name">{row.text}</span>
                <button type="button" data-testid="nas-revoke" onClick={() => onRevoke(row.id)}>
                  Revoke
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div>
        <button type="button" data-testid="nas-rescan" onClick={onRescan}>
          Rescan
        </button>
      </div>
      {status && (
        <p className="status" role="status" data-testid="nas-admin-status">
          {status}
        </p>
      )}
      {error && (
        <div className="error-banner" role="alert" data-testid="nas-admin-error">
          {error}
        </div>
      )}
    </section>
  );
}
