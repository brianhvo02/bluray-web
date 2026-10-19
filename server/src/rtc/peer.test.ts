import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RTCPeerConnection } from 'werift';
import type { RTCDataChannel } from 'werift';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WireClient } from '../../../src/engine/disc/rtc-wire';
import { appHandlers } from '../app';
import { Auth } from '../auth';
import { BdjStore } from '../bdj-store';
import type { Handler } from '../http';
import { Library, SETTLE_MS } from '../library';
import { Store } from '../store';
import { answerWithCandidates, RtcPeers, RtcRefused, routeOf, wireChannelOf } from './peer';

// Every name here is made up. Ports 47990–47997 are the tests' own, so a real NAS on 47998 never clashes.

const INDEX = Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 37 + 11) & 0xff));

let tmp: string;
let auth: Auth;
let library: Library;
let handlers: Handler[];
const open: Array<{ close(): unknown }> = [];

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'rtc-peer-'));
  const data = join(tmp, 'data');
  const disc = join(tmp, 'root', 'Starfall Wanderer Vol 1', 'BDMV');
  mkdirSync(disc, { recursive: true });
  writeFileSync(join(disc, 'index.bdmv'), INDEX);
  auth = new Auth(new Store(data), Date.now);
  library = new Library([{ name: 'drv', dir: join(tmp, 'root') }], join(data, 'library.json'), { scanPauseMs: 0, now: () => Date.now() + SETTLE_MS + 1 });
  await library.scan();
  handlers = appHandlers({ auth, library, bdjStore: new BdjStore(data), publicBase: 'https://nas.example/bluray/api/' });
});

afterEach(async () => {
  for (const o of open.splice(0).reverse()) await o.close();
  rmSync(tmp, { recursive: true, force: true });
});

function peersOn(port: number, limits?: ConstructorParameters<typeof RtcPeers>[0]['limits']): RtcPeers {
  const peers = new RtcPeers({ handlers, auth, port, advertise: () => ['127.0.0.1'], iceServers: async () => [], now: Date.now, limits });
  open.push({ close: () => peers.closeAll() });
  return peers;
}

/** A device's side: an `api` channel offered to `peers` as `sid`, its candidates trickled. */
async function connect(peers: RtcPeers, sid: string): Promise<{ pc: RTCPeerConnection; dc: RTCDataChannel; answer: string; client: WireClient }> {
  const pc = new RTCPeerConnection({ iceServers: [], iceUseIpv6: false });
  open.push({ close: () => pc.close() });
  const dc = pc.createDataChannel('api');
  pc.onIceCandidate.subscribe((c) => {
    if (c) peers.candidate(sid, c.toJSON());
  });
  await pc.setLocalDescription(await pc.createOffer());
  const { answer } = await peers.answer(sid, pc.localDescription!.sdp);
  await pc.setRemoteDescription({ type: 'answer', sdp: answer });
  await new Promise<void>((resolve, reject) => {
    if (dc.readyState === 'open') return resolve();
    const timer = setTimeout(() => reject(new Error('channel did not open')), 10_000);
    dc.stateChanged.subscribe((s) => {
      if (s === 'open') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return { pc, dc, answer, client: new WireClient(wireChannelOf(dc)) };
}

async function deviceKey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const sign = async (text: string): Promise<string> =>
    Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(text))).toString('base64url');
  return { jwk, sign };
}

/** Redeems a fresh code and starts a session over `client`: the device id and its token. */
async function sessionOver(client: WireClient): Promise<{ deviceId: string; token: string }> {
  const post = (path: string, body: unknown): Promise<Response> =>
    client.fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const { jwk, sign } = await deviceKey();
  const { code } = auth.createCode({ newPerson: { name: 'Mika', owner: false } });
  const redeemed = await post('/api/pair/redeem', { code, deviceName: 'Phone', publicKeyJwk: jwk });
  expect(redeemed.status).toBe(200);
  const { deviceId } = (await redeemed.json()) as { deviceId: string };
  const { challenge } = (await (await post('/api/session/challenge', { deviceId })).json()) as { challenge: string };
  const res = await post('/api/session', { deviceId, challenge, signature: await sign(challenge) });
  expect(res.status).toBe(200);
  return { deviceId, token: ((await res.json()) as { token: string }).token };
}

async function readRange(client: WireClient, token: string, from: number, to: number): Promise<Buffer> {
  const [disc] = library.list('')!.discs;
  const res = await client.fetch(`/api/discs/${disc!.id}/files/BDMV/index.bdmv?t=${encodeURIComponent(token)}`, { headers: { Range: `bytes=${from}-${to}` } });
  expect(res.status).toBe(206);
  return Buffer.from(await res.arrayBuffer());
}

const candidateLines = (sdp: string): string[] => sdp.split(/\r?\n/).filter((l) => l.startsWith('a=candidate:'));

describe('RtcPeers', () => {
  it('serves the api channel over a real connection: a session, then a disc range byte-exact', { timeout: 30_000 }, async () => {
    const peers = peersOn(47991);
    const { client } = await connect(peers, 'sid-aaaaaaaaaaaaaaaaaaa');
    const { deviceId, token } = await sessionOver(client);
    const bytes = await readRange(client, token, 1000, 250_999);
    expect(bytes.equals(INDEX.subarray(1000, 251_000))).toBe(true);
    expect(auth.devices().find((d) => d.id === deviceId)?.lastRoute).toBe('webrtc');
  });

  it('answers with only the advertised host candidates on its port', { timeout: 30_000 }, async () => {
    const peers = peersOn(47992);
    const { answer } = await connect(peers, 'sid-bbbbbbbbbbbbbbbbbbb');
    const lines = candidateLines(answer);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^a=candidate:\S+ 1 udp \d+ 127\.0\.0\.1 47992 typ host/);
    expect(answer).toContain('a=end-of-candidates');
    expect(answer).not.toMatch(/(^|[\s:])172\.(1[6-9]|2\d|3[01])\./m);
    expect(answer).not.toMatch(/(^|[\s:])100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./m);
  });

  it('serves two devices at once on the one UDP port', { timeout: 30_000 }, async () => {
    const peers = peersOn(47993);
    const a = await connect(peers, 'sid-ccccccccccccccccccc');
    const b = await connect(peers, 'sid-ddddddddddddddddddd');
    const [sa, sb] = await Promise.all([sessionOver(a.client), sessionOver(b.client)]);
    const [ra, rb] = await Promise.all([readRange(a.client, sa.token, 0, 99_999), readRange(b.client, sb.token, 100_000, 199_999)]);
    expect(ra.equals(INDEX.subarray(0, 100_000))).toBe(true);
    expect(rb.equals(INDEX.subarray(100_000, 200_000))).toBe(true);
    expect(peers.size).toBe(2);
  });

  it('cleans a peer up when its channel closes', { timeout: 30_000 }, async () => {
    const peers = peersOn(47994);
    const { dc } = await connect(peers, 'sid-eeeeeeeeeeeeeeeeeee');
    expect(peers.size).toBe(1);
    dc.close();
    await expect.poll(() => peers.size, { timeout: 5000 }).toBe(0);
  });

  it('refuses a fifth offer from one sid and a peer over the limit, and drops one whose channel never opens', { timeout: 30_000 }, async () => {
    const peers = peersOn(47995, { peers: 3, unopenedMs: 300 });
    const device = new RTCPeerConnection({ iceServers: [], iceUseIpv6: false });
    open.push({ close: () => device.close() });
    device.createDataChannel('api');
    await device.setLocalDescription(await device.createOffer());
    const offer = device.localDescription!.sdp;

    for (let i = 0; i < 4; i++) await peers.answer('sid-fffffffffffffffffff', offer);
    await expect(peers.answer('sid-fffffffffffffffffff', offer)).rejects.toEqual(new RtcRefused('too-many-offers'));
    expect(peers.size).toBe(1); // a new offer from a sid replaces its peer
    await peers.answer('sid-ggggggggggggggggggg', offer);
    await peers.answer('sid-hhhhhhhhhhhhhhhhhhh', offer);
    await expect(peers.answer('sid-iiiiiiiiiiiiiiiiiii', offer)).rejects.toEqual(new RtcRefused('busy'));
    await expect.poll(() => peers.size, { timeout: 5000 }).toBe(0);
    await peers.answer('sid-iiiiiiiiiiiiiiiiiii', offer);
    expect(peers.size).toBe(1);
  });
});

describe('answerWithCandidates', () => {
  const sdp = [
    'v=0',
    'o=- 1 0 IN IP4 0.0.0.0',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    'a=mid:0',
    'a=candidate:1 1 udp 2130706431 172.18.0.5 47998 typ host',
    'a=candidate:2 1 udp 2130706431 100.101.102.103 47998 typ host',
    'a=candidate:3 1 udp 1694498815 203.0.113.9 51000 typ srflx raddr 172.18.0.5 rport 47998',
    'a=end-of-candidates',
    'a=sctp-port:5000',
    '',
  ].join('\r\n');

  it('replaces every candidate with the advertised addresses on the port', () => {
    const out = answerWithCandidates(sdp, ['203.0.113.9', '192.168.1.98'], 47998);
    expect(candidateLines(out)).toEqual([
      'a=candidate:1 1 udp 2130706431 203.0.113.9 47998 typ host generation 0',
      'a=candidate:2 1 udp 2130706175 192.168.1.98 47998 typ host generation 0',
    ]);
    expect(out).toContain('c=IN IP4 203.0.113.9');
    expect(out).not.toContain('172.18.');
    expect(out).not.toContain('100.101.');
    expect(out.split('a=end-of-candidates')).toHaveLength(2);
    expect(out.endsWith('\r\n')).toBe(true);
  });

  it('never advertises a Docker or Tailscale address even when told to', () => {
    const out = answerWithCandidates(sdp, ['172.20.0.2', '100.64.1.1', '192.168.1.98'], 47998);
    expect(candidateLines(out)).toEqual(['a=candidate:1 1 udp 2130706431 192.168.1.98 47998 typ host generation 0']);
  });
});

describe('routeOf', () => {
  it('is relay when either end of the selected pair is a relay candidate', () => {
    expect(routeOf({ localCandidate: { type: 'host' }, remoteCandidate: { type: 'relay' } })).toBe('relay');
    expect(routeOf({ localCandidate: { type: 'relay' }, remoteCandidate: { type: 'srflx' } })).toBe('relay');
    expect(routeOf({ localCandidate: { type: 'host' }, remoteCandidate: { type: 'prflx' } })).toBe('webrtc');
    expect(routeOf(undefined)).toBe('webrtc');
  });
});
