import type { webcrypto } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { base64url, turnProofMessage } from '../../../rendezvous/src/protocol';
import type { IceServerInfo } from '../../../rendezvous/src/protocol';
import { Auth } from '../auth';
import { codeHash } from '../codes';
import { Store } from '../store';
import { FREE_BYTES, RelayState, turnResponder } from './relay';

// Every name here is made up.

const OCT_15 = Date.UTC(2026, 9, 15, 12);
const SID = 'AAAAAAAAAAAAAAAAAAAAAA';
const SERVERS: IceServerInfo[] = [{ urls: ['turn:turn.example:3478'], username: 'u', credential: 'c' }];

let tmp: string;
let clock: number;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'relay-'));
  clock = OCT_15;
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('RelayState', () => {
  it('is off by default, so it may not relay', () => {
    const relay = new RelayState(tmp, () => clock);
    expect(relay.settings()).toEqual({ enabled: false, allowPaid: false });
    expect(relay.mayRelay()).toBe(false);
    relay.set({ enabled: true });
    expect(relay.mayRelay()).toBe(true);
  });

  it('stops at the free 1,000 GB unless paid use is allowed', () => {
    const relay = new RelayState(tmp, () => clock);
    relay.set({ enabled: true });
    relay.addBytes(FREE_BYTES - 1);
    expect(relay.mayRelay()).toBe(true);
    relay.addBytes(1);
    expect(relay.usage()).toEqual({ usedBytes: 1e12, freeBytes: 1e12, resetsOn: '2026-11-01' });
    expect(relay.mayRelay()).toBe(false);
    relay.set({ allowPaid: true });
    expect(relay.mayRelay()).toBe(true);
    expect(relay.settings()).toEqual({ enabled: true, allowPaid: true });
  });

  it('resets usage on the 1st of the next month, UTC', () => {
    const relay = new RelayState(tmp, () => clock);
    relay.set({ enabled: true });
    relay.addBytes(FREE_BYTES);
    clock = Date.UTC(2026, 9, 31, 23, 59, 59);
    expect(relay.usage().usedBytes).toBe(FREE_BYTES);
    clock = Date.UTC(2026, 10, 1, 0, 0, 0);
    expect(relay.usage()).toEqual({ usedBytes: 0, freeBytes: 1e12, resetsOn: '2026-12-01' });
    expect(relay.mayRelay()).toBe(true);
    clock = Date.UTC(2026, 11, 20);
    expect(relay.usage().resetsOn).toBe('2027-01-01');
  });

  it('keeps its state in relay.json across restarts, and a new month forgets old bytes', () => {
    const relay = new RelayState(tmp, () => clock);
    relay.set({ enabled: true, allowPaid: true });
    relay.addBytes(5_000);
    expect(JSON.parse(readFileSync(join(tmp, 'relay.json'), 'utf8'))).toEqual({ enabled: true, allowPaid: true, month: '2026-10', usedBytes: 5_000 });
    expect(new RelayState(tmp, () => clock).usage().usedBytes).toBe(5_000);
    expect(new RelayState(tmp, () => clock).settings()).toEqual({ enabled: true, allowPaid: true });
    clock = Date.UTC(2026, 10, 2);
    const later = new RelayState(tmp, () => clock);
    expect(later.usage().usedBytes).toBe(0);
    later.addBytes(7);
    expect(later.usage().usedBytes).toBe(7);
  });

  it('ignores negative, fractional and non-finite byte counts', () => {
    const relay = new RelayState(tmp, () => clock);
    for (const n of [-5, Number.NaN, Infinity]) relay.addBytes(n);
    relay.addBytes(2.7);
    expect(relay.usage().usedBytes).toBe(2);
  });
});

describe('turnResponder', () => {
  let auth: Auth;
  let relay: RelayState;
  let credentials: ReturnType<typeof vi.fn<() => Promise<IceServerInfo[]>>>;
  let respond: ReturnType<typeof turnResponder>;

  beforeEach(() => {
    auth = new Auth(new Store(join(tmp, 'data')), () => clock);
    relay = new RelayState(join(tmp, 'data'), () => clock);
    relay.set({ enabled: true });
    credentials = vi.fn(async () => SERVERS);
    respond = turnResponder({ relay, auth, credentials, now: () => clock });
  });

  /** A paired device: its id and a way to sign its TURN proof. */
  async function pairedDevice(): Promise<{ deviceId: string; proof: (sid: string, ts: number) => Promise<string> }> {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const { code } = auth.createCode({ newPerson: { name: 'Mika', owner: false } });
    const device = auth.redeem(code, 'Phone', jwk)!;
    const proof = async (sid: string, ts: number): Promise<string> =>
      base64url(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, turnProofMessage({ sid, ts }))));
    return { deviceId: device.id, proof };
  }

  it("gives a paired device's good proof the servers", async () => {
    const { deviceId, proof } = await pairedDevice();
    expect(await respond(SID, { t: 'turn-request', deviceId, ts: clock - 59_000, signature: await proof(SID, clock - 59_000) })).toEqual({ iceServers: SERVERS });
    expect(credentials).toHaveBeenCalledTimes(1);
  });

  it('answers off while the relay is off, and limit with the reset date at the allowance', async () => {
    const { deviceId, proof } = await pairedDevice();
    const request = { t: 'turn-request', deviceId, ts: clock, signature: await proof(SID, clock) };
    relay.set({ enabled: false });
    expect(await respond(SID, request)).toEqual({ iceServers: [], reason: 'off' });
    relay.set({ enabled: true });
    relay.addBytes(FREE_BYTES);
    expect(await respond(SID, request)).toEqual({ iceServers: [], reason: 'limit', resetsOn: '2026-11-01' });
    relay.set({ allowPaid: true });
    expect(await respond(SID, request)).toEqual({ iceServers: SERVERS });
  });

  it('refuses a forged, stale, replayed-from-another-socket or unknown-device proof as unauthorized', async () => {
    const { deviceId, proof } = await pairedDevice();
    const other = await pairedDevice();
    const requests = [
      { t: 'turn-request', deviceId, ts: clock, signature: await other.proof(SID, clock) },
      { t: 'turn-request', deviceId, ts: clock - 61_000, signature: await proof(SID, clock - 61_000) },
      { t: 'turn-request', deviceId, ts: clock + 61_000, signature: await proof(SID, clock + 61_000) },
      { t: 'turn-request', deviceId, ts: clock, signature: await proof('BBBBBBBBBBBBBBBBBBBBBB', clock) },
      { t: 'turn-request', deviceId: 'nobody', ts: clock, signature: await proof(SID, clock) },
      { t: 'turn-request', deviceId, ts: clock, signature: 'not a signature' },
      { t: 'turn-request', deviceId, ts: String(clock), signature: await proof(SID, clock) },
      { t: 'turn-request' },
    ];
    for (const request of requests) expect(await respond(SID, request), JSON.stringify(request)).toEqual({ iceServers: [], reason: 'unauthorized' });
    // nothing is revealed about the switch to a stranger
    relay.set({ enabled: false });
    expect(await respond(SID, requests[0]!)).toEqual({ iceServers: [], reason: 'unauthorized' });
    expect(credentials).not.toHaveBeenCalled();
  });

  it("gives a live invite's hash the servers; an expired invite or a plain code is unauthorized", async () => {
    const owner = auth.firstOwnerPerson();
    const invite = auth.createCode({ personId: owner.id }, { invite: true });
    const plain = auth.createCode({ personId: owner.id });
    expect(await respond(SID, { t: 'turn-request', inviteHash: codeHash(invite.code) })).toEqual({ iceServers: SERVERS });
    expect(await respond(SID, { t: 'turn-request', inviteHash: codeHash(plain.code) })).toEqual({ iceServers: [], reason: 'unauthorized' });
    clock = invite.record.expiresAt;
    expect(await respond(SID, { t: 'turn-request', inviteHash: codeHash(invite.code) })).toEqual({ iceServers: [], reason: 'unauthorized' });
  });

  it('answers unavailable when the credentials cannot be had', async () => {
    const { deviceId, proof } = await pairedDevice();
    credentials.mockRejectedValueOnce(new Error('rendezvous POST /turn answered 503'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await respond(SID, { t: 'turn-request', deviceId, ts: clock, signature: await proof(SID, clock) })).toEqual({ iceServers: [], reason: 'unavailable' });
    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });
});
