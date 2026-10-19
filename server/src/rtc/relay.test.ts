import type { webcrypto } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { base64url, turnProofMessage } from '../../../rendezvous/src/protocol';
import type { IceServerInfo } from '../../../rendezvous/src/protocol';
import { Auth } from '../auth';
import { codeHash } from '../codes';
import { Store } from '../store';
import { FREE_BYTES, RelayState, TURN_REQUESTS_PER_HOUR, turnHosts, turnResponder } from './relay';

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

  it('keeps the count when the clock steps back across a month boundary', () => {
    clock = Date.UTC(2026, 10, 1, 0, 0, 5);
    const relay = new RelayState(tmp, () => clock);
    relay.addBytes(900);
    clock = Date.UTC(2026, 9, 31, 23, 59, 58);
    expect(relay.usage().usedBytes).toBe(900);
    relay.addBytes(100);
    expect(new RelayState(tmp, () => clock).usage().usedBytes).toBe(1_000);
    clock = Date.UTC(2026, 10, 1, 0, 0, 6);
    expect(relay.usage().usedBytes).toBe(1_000);
    clock = Date.UTC(2026, 11, 1);
    expect(relay.usage().usedBytes).toBe(0);
  });

  it('starts fresh, relay off, from a corrupt or unreadable relay.json, and logs it', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const text of ['{', '[]', 'null']) {
      writeFileSync(join(tmp, 'relay.json'), text);
      const relay = new RelayState(tmp, () => clock);
      expect(relay.settings()).toEqual({ enabled: false, allowPaid: false });
      expect(relay.usage().usedBytes).toBe(0);
    }
    const dir = join(tmp, 'as-dir');
    rmSync(dir, { recursive: true, force: true });
    const unreadable = join(dir, 'relay.json');
    // a directory where the file should be cannot be read as one
    mkdirSync(unreadable, { recursive: true });
    expect(new RelayState(dir, () => clock).mayRelay()).toBe(false);
    expect(log).toHaveBeenCalledTimes(4);
    log.mockRestore();
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

  it('allows 10 checked requests an hour per device and per invite, then answers unauthorized; forgeries use none up', async () => {
    const { deviceId, proof } = await pairedDevice();
    const forged = await pairedDevice();
    for (let i = 0; i < 20; i++) await respond(SID, { t: 'turn-request', deviceId, ts: clock, signature: await forged.proof(SID, clock) });
    const good = async () => respond(SID, { t: 'turn-request', deviceId, ts: clock, signature: await proof(SID, clock) });
    for (let i = 0; i < TURN_REQUESTS_PER_HOUR; i++) expect(await good()).toEqual({ iceServers: SERVERS });
    expect(await good()).toEqual({ iceServers: [], reason: 'unauthorized' });
    const invite = auth.createCode({ personId: auth.firstOwnerPerson().id }, { invite: true });
    const byInvite = () => respond(SID, { t: 'turn-request', inviteHash: codeHash(invite.code) });
    for (let i = 0; i < TURN_REQUESTS_PER_HOUR; i++) expect(await byInvite()).toEqual({ iceServers: SERVERS });
    expect(await byInvite()).toEqual({ iceServers: [], reason: 'unauthorized' });
    // another device is unaffected, and the window slides
    const other = await pairedDevice();
    expect(await respond(SID, { t: 'turn-request', deviceId: other.deviceId, ts: clock, signature: await other.proof(SID, clock) })).toEqual({ iceServers: SERVERS });
    clock += 60 * 60_000;
    expect(await good()).toEqual({ iceServers: SERVERS });
  });

  it("resolves the handed-out TURN urls' hosts and reports their addresses for the sid", async () => {
    credentials.mockResolvedValue([
      { urls: ['stun:stun.example:3478'] },
      { urls: ['turn:turn.example:3478?transport=udp', 'turns:turn.example:443?transport=tcp', 'turn:[2001:db8::7]:3478', 'turn:198.51.100.9'], username: 'u', credential: 'c' },
    ]);
    const lookup = vi.fn(async (host: string) => (host === 'turn.example' ? ['198.51.100.1', '2001:db8::1'] : [host]));
    const seen: [string, string[]][] = [];
    respond = turnResponder({ relay, auth, credentials, now: () => clock, lookup, onServers: (sid, ips) => seen.push([sid, ips]) });
    const { deviceId, proof } = await pairedDevice();
    await respond(SID, { t: 'turn-request', deviceId, ts: clock, signature: await proof(SID, clock) });
    expect(lookup.mock.calls.map((c) => c[0])).toEqual(['turn.example', '2001:db8::7', '198.51.100.9']);
    expect(seen).toEqual([[SID, ['198.51.100.1', '2001:db8::1', '2001:db8::7', '198.51.100.9']]]);
  });

  it('turnHosts reads turn and turns urls only', () => {
    expect(turnHosts([{ urls: 'stun:s.example' }, { urls: ['TURN:t.example:3478', 'turns:t.example', 'turn:[::1]:3478?transport=tcp'] }])).toEqual(['t.example', '::1']);
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
