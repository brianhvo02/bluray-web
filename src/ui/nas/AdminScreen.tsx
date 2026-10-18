import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { TMDB_ATTRIBUTION, countdown, deviceRow, matchingStatus, newCode, revoke } from './admin-model';
import type { NasClient, NasDevice, NasTitleStatus } from './nas-client';
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
/** While titles are being matched, the status is reloaded this often. */
const STATUS_POLL_MS = 5_000;

interface ShownCode {
  readonly code: string;
  readonly link: string;
  readonly expiresAt: number;
  readonly qr: { size: number; path: string };
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The title library's part of NAS settings: the matching status, the release gate (off by default; turning it on asks
 * first) and TMDB's attribution. Absent when the NAS has no title library (its status route answers 404).
 */
function TitleLibrarySettings({ nas, now }: { nas: NasClient; now: () => number }): ReactElement {
  const [status, setStatus] = useState<NasTitleStatus | null>(null);
  const [missing, setMissing] = useState(false);
  const [everyone, setEveryone] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    let timer: number | undefined;
    const load = (): void => {
      nas.admin.titleStatus().then(
        (s) => {
          if (!live) return;
          setStatus(s);
          if (s.running) timer = window.setTimeout(load, STATUS_POLL_MS);
        },
        () => {
          if (live) setMissing(true);
        },
      );
    };
    load();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [nas]);

  const setGate = (open: boolean): void => {
    setBusy(true);
    setError(null);
    nas.admin.setTitleLibrary(open ? 'everyone' : 'owners').then(
      () => {
        setBusy(false);
        setConfirming(false);
        setEveryone(open);
      },
      (err: unknown) => {
        setBusy(false);
        setError(message(err));
      },
    );
  };

  const shown = status === null ? null : matchingStatus(status, now());
  return (
    <section className="admin-titles" data-testid="nas-title-settings" aria-labelledby="admin-titles-head">
      <h3 id="admin-titles-head">Title library</h3>
      {shown && (
        <div data-testid="nas-matching">
          <p className="status">{shown.progress}</p>
          <p className="status">{shown.counts}</p>
          {shown.tmdb && <p className="status">{shown.tmdb}</p>}
        </div>
      )}
      {!missing && status !== null && (
        <>
          <label className="admin-switch">
            <input
              type="checkbox"
              role="switch"
              data-testid="nas-gate"
              checked={everyone || confirming}
              disabled={busy}
              onChange={(e) => (e.target.checked ? setConfirming(true) : confirming ? setConfirming(false) : setGate(false))}
            />{' '}
            Show the title library to everyone
          </label>
          {confirming && (
            <div className="admin-confirm-box" role="group" aria-label="Confirm">
              <p>Guests will browse by title from their next app load. Hidden discs stay hidden.</p>
              <button type="button" data-testid="nas-gate-confirm" disabled={busy} onClick={() => setGate(true)}>
                Show to everyone
              </button>{' '}
              <button type="button" data-testid="nas-gate-cancel" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </div>
          )}
        </>
      )}
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      <p className="admin-tmdb" data-testid="nas-tmdb">
        <img src={`${import.meta.env.BASE_URL}tmdb-logo.svg`} alt="TMDB" width={92} height={12} />
        <span data-testid="nas-tmdb-text">{TMDB_ATTRIBUTION}</span>
      </p>
    </section>
  );
}

/** NAS settings, for owners: a new pairing code with its QR and countdown, the paired devices with Revoke, and Rescan. */
export function AdminScreen({ nas, thisDeviceId, onClose, now = Date.now }: AdminScreenProps): ReactElement {
  const [devices, setDevices] = useState<NasDevice[] | null>(null);
  const [owner, setOwner] = useState(false);
  const [code, setCode] = useState<ShownCode | null>(null);
  const [copied, setCopied] = useState(false);
  const [minting, setMinting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Rows whose revoke is in flight: their button is disabled, so a double tap sends one request. */
  const [revoking, setRevoking] = useState<ReadonlySet<string>>(new Set());
  /** This device's row asks "Revoke this device?" before revoking. */
  const [confirmingSelf, setConfirmingSelf] = useState(false);
  const codeRef = useRef<HTMLElement>(null);
  const [, setTick] = useState(0);

  /** Loads the devices. A failing poll only shows its error when no other is showing, so it can't hide a refusal unread. */
  const loadDevices = useCallback(
    (poll: boolean): Promise<void> =>
      nas.admin.devices().then(setDevices, (err: unknown) => setError((shown) => (poll && shown !== null ? shown : message(err)))),
    [nas],
  );
  useEffect(() => {
    void loadDevices(false);
  }, [loadDevices]);

  const live = code !== null && now() < code.expiresAt;
  useEffect(() => {
    if (!live) return;
    const tick = window.setInterval(() => setTick((t) => t + 1), 1_000);
    const poll = window.setInterval(() => void loadDevices(true), DEVICE_POLL_MS);
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

  /** Without a clipboard (no secure context, some webviews), or when writing fails, the code is selected instead. */
  const canCopy = typeof navigator.clipboard?.writeText === 'function';
  const selectCode = (): void => {
    const el = codeRef.current;
    if (el) window.getSelection()?.selectAllChildren(el);
  };
  const onCopy = (): void => {
    if (!code) return;
    let writing: Promise<void>;
    try {
      writing = navigator.clipboard.writeText(code.code);
    } catch {
      selectCode();
      return;
    }
    writing.then(
      () => setCopied(true),
      () => {
        setCopied(false);
        selectCode();
      },
    );
  };

  const onRevoke = (id: string): void => {
    setError(null);
    setConfirmingSelf(false);
    setRevoking((ids) => new Set(ids).add(id));
    void revoke(nas.admin, id).then((failed) => {
      setRevoking((ids) => {
        const next = new Set(ids);
        next.delete(id);
        return next;
      });
      if (failed) {
        setError(failed);
        return;
      }
      setDevices((list) => list?.filter((d) => d.id !== id) ?? null);
      void loadDevices(false);
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
            <code ref={codeRef} className="admin-code-text" data-testid="nas-code">
              {code.code}
            </code>{' '}
            {canCopy && (
              <button type="button" data-testid="nas-code-copy" onClick={onCopy}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            )}
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
                {row.thisDevice && confirmingSelf ? (
                  <span className="admin-confirm">
                    Revoke this device?{' '}
                    <button type="button" data-testid="nas-revoke-confirm" disabled={revoking.has(row.id)} onClick={() => onRevoke(row.id)}>
                      Revoke
                    </button>{' '}
                    <button type="button" data-testid="nas-revoke-cancel" onClick={() => setConfirmingSelf(false)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    data-testid="nas-revoke"
                    disabled={revoking.has(row.id)}
                    onClick={() => (row.thisDevice ? setConfirmingSelf(true) : onRevoke(row.id))}
                  >
                    Revoke
                  </button>
                )}
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
      <TitleLibrarySettings nas={nas} now={now} />
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
