import { useState, type FormEvent, type ReactElement } from 'react';
import { normalizeCode } from '../../engine/disc/pairing-code';
import { NAS_MESSAGES, defaultDeviceName, groupCodeInput, type NasClient } from './nas-client';

interface PairScreenProps {
  readonly client: NasClient;
  /** A code from a `?pair=` link. */
  readonly initialCode?: string;
  readonly onPaired: () => void;
}

/** The pairing code, this device's name and a Pair button. */
export function PairScreen({ client, initialCode = '', onPaired }: PairScreenProps): ReactElement {
  const [code, setCode] = useState(() => groupCodeInput(initialCode));
  const [deviceName, setDeviceName] = useState(() => defaultDeviceName(navigator.userAgent, navigator.maxTouchPoints));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() => (initialCode && !client.canPairByCode ? NAS_MESSAGES.noRendezvous : null));

  const onSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    client.pair(code, deviceName).then(onPaired, (err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    });
  };

  return (
    <section className="pair" data-testid="pair-screen">
      <h2>Pair with a NAS</h2>
      <form onSubmit={onSubmit}>
        <label>
          Pairing code{' '}
          <input
            data-testid="pair-code"
            value={code}
            onChange={(e) => setCode(groupCodeInput(e.target.value))}
            placeholder="XXXX-XXXX-XXXX"
            maxLength={14}
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            disabled={busy}
          />
        </label>{' '}
        <label>
          Device name{' '}
          <input data-testid="pair-device-name" value={deviceName} onChange={(e) => setDeviceName(e.target.value)} maxLength={100} disabled={busy} />
        </label>{' '}
        <button type="submit" data-testid="pair-button" disabled={busy || normalizeCode(code) === null || deviceName.trim() === ''}>
          Pair
        </button>
      </form>
      {busy && (
        <p className="status" role="status">
          {NAS_MESSAGES.allowLocalNetwork}
        </p>
      )}
      {error && (
        <div className="error-banner" role="alert" data-testid="pair-error">
          {error}
        </div>
      )}
    </section>
  );
}
