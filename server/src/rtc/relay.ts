import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TURN_MAX_SKEW_MS, turnProofMessage } from '../../../rendezvous/src/protocol';
import type { IceServerInfo, TurnRefusal } from '../../../rendezvous/src/protocol';
import { isCode, replaceAtomically } from '../atomic-json';
import type { Auth } from '../auth';

/** Cloudflare's free relay allowance a month (1,000 GB, shared by TURN and its SFU; checked 2026-10-19). */
export const FREE_BYTES = 1e12;

export interface RelaySettings {
  enabled: boolean;
  allowPaid: boolean;
}

export interface RelayUsage {
  usedBytes: number;
  freeBytes: number;
  /** The UTC date usage next resets: the 1st of next month, `YYYY-MM-DD`. */
  resetsOn: string;
}

interface RelayFile extends RelaySettings {
  /** The UTC month `usedBytes` counts, `YYYY-MM`. */
  month: string;
  usedBytes: number;
}

/** `YYYY-MM` of `ms`, UTC. */
function monthOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

/** `YYYY-MM-DD` of the 1st of the month after `ms`, UTC. */
function nextFirstOf(ms: number): string {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}

/**
 * The relay's owner settings and this month's relayed bytes, kept in `<dataDir>/relay.json` (replaced atomically).
 * Off by default. Usage is the NAS's own estimate (ruling P2-R1): bytes both ways on connections it classed as
 * relayed, sampled from werift's counters; Cloudflare's analytics would need another token.
 */
export class RelayState {
  private readonly file: string;
  private state: RelayFile;

  constructor(
    private readonly dataDir: string,
    private readonly now: () => number,
  ) {
    this.file = join(dataDir, 'relay.json');
    this.state = this.load();
  }

  settings(): RelaySettings {
    const { enabled, allowPaid } = this.state;
    return { enabled, allowPaid };
  }

  set(change: Partial<RelaySettings>): void {
    this.state = {
      ...this.current(),
      ...(change.enabled === undefined ? {} : { enabled: change.enabled }),
      ...(change.allowPaid === undefined ? {} : { allowPaid: change.allowPaid }),
    };
    this.save();
  }

  /** Adds relayed bytes to this month's count; anything but a positive count is ignored. */
  addBytes(n: number): void {
    if (!Number.isFinite(n) || n < 1) return;
    const current = this.current();
    this.state = { ...current, usedBytes: current.usedBytes + Math.floor(n) };
    this.save();
  }

  usage(): RelayUsage {
    return { usedBytes: this.current().usedBytes, freeBytes: FREE_BYTES, resetsOn: nextFirstOf(this.now()) };
  }

  /** Whether a new relayed session may start: the relay is on, and under the free allowance unless paid use is allowed. */
  mayRelay(): boolean {
    const { enabled, allowPaid, usedBytes } = this.current();
    return enabled && (allowPaid || usedBytes < FREE_BYTES);
  }

  /** The state with a past month's bytes forgotten. */
  private current(): RelayFile {
    const month = monthOf(this.now());
    return this.state.month === month ? this.state : { ...this.state, month, usedBytes: 0 };
  }

  private load(): RelayFile {
    const fresh: RelayFile = { enabled: false, allowPaid: false, month: monthOf(this.now()), usedBytes: 0 };
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (err) {
      if (isCode(err, 'ENOENT')) return fresh;
      throw err;
    }
    const raw = JSON.parse(text) as Partial<RelayFile>;
    return {
      enabled: raw.enabled === true,
      allowPaid: raw.allowPaid === true,
      month: typeof raw.month === 'string' ? raw.month : fresh.month,
      usedBytes: typeof raw.usedBytes === 'number' && Number.isFinite(raw.usedBytes) && raw.usedBytes >= 0 ? raw.usedBytes : 0,
    };
  }

  private save(): void {
    mkdirSync(this.dataDir, { recursive: true });
    replaceAtomically(this.file, JSON.stringify(this.state));
  }
}

/** What a device's `turn-request` gets: servers, or none and why. */
export type TurnAnswer = { iceServers: IceServerInfo[] } | { iceServers: []; reason: TurnRefusal; resetsOn?: string };

export interface TurnResponderOptions {
  relay: RelayState;
  auth: Auth;
  /** Fresh TURN credentials from the rendezvous Worker (`RendezvousClient.turnServers`). */
  credentials: () => Promise<IceServerInfo[]>;
  now: () => number;
}

/**
 * Answers a device's `turn-request` on the signalling socket `sid` (spec §6.4). The device must check out first, so
 * a stranger learns nothing about the relay: a paired device by its signature over `turnProofMessage({ sid, ts })`
 * with `ts` within 60 s, or an unpaired one by the hash of a live invite code. Then the relay must be on and,
 * unless paid use is allowed, under its free allowance.
 */
export function turnResponder(opts: TurnResponderOptions): (sid: string, request: Record<string, unknown>) => Promise<TurnAnswer> {
  const refuse = (reason: TurnRefusal, resetsOn?: string): TurnAnswer => ({ iceServers: [], reason, ...(resetsOn === undefined ? {} : { resetsOn }) });
  const checksOut = (sid: string, request: Record<string, unknown>): boolean => {
    const { deviceId, ts, signature, inviteHash } = request;
    if (typeof deviceId === 'string' && typeof ts === 'number' && typeof signature === 'string') {
      if (!Number.isSafeInteger(ts) || Math.abs(opts.now() - ts) > TURN_MAX_SKEW_MS) return false;
      return opts.auth.signedBy(deviceId, turnProofMessage({ sid, ts }), signature) !== null;
    }
    if (typeof inviteHash === 'string') return opts.auth.codes().some((c) => c.invite && c.hash === inviteHash);
    return false;
  };
  return async (sid, request) => {
    if (!checksOut(sid, request)) return refuse('unauthorized');
    const { relay } = opts;
    if (!relay.settings().enabled) return refuse('off');
    if (!relay.mayRelay()) return refuse('limit', relay.usage().resetsOn);
    try {
      return { iceServers: await opts.credentials() };
    } catch (err) {
      console.error('relay: TURN credentials could not be had', err);
      return refuse('unavailable');
    }
  };
}
