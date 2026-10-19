import { createSocket } from 'node:dgram';
import type { Socket } from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import { advertisable, AddressAdvertiser, discoverPublicIpv4 } from './public-address';

const MAGIC = 0x2112a442;

/** A STUN server on loopback that answers each Binding request with XOR-MAPPED-ADDRESS `mapped()`, or not at all. */
async function fakeStun(mapped: () => string | null): Promise<{ url: string; socket: Socket; requests: number }> {
  const socket = createSocket('udp4');
  const state = { url: '', socket, requests: 0 };
  socket.on('message', (msg, rinfo) => {
    state.requests++;
    const ip = mapped();
    if (ip === null || msg.length < 20 || msg.readUInt16BE(0) !== 0x0001) return;
    const res = Buffer.alloc(20 + 12);
    res.writeUInt16BE(0x0101, 0);
    res.writeUInt16BE(12, 2);
    msg.copy(res, 4, 4, 20); // magic cookie and transaction id
    res.writeUInt16BE(0x0020, 20);
    res.writeUInt16BE(8, 22);
    res.writeUInt8(0, 24);
    res.writeUInt8(1, 25);
    res.writeUInt16BE(rinfo.port ^ (MAGIC >>> 16), 26);
    const octets = ip.split('.').map(Number);
    res.writeUInt32BE((((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) ^ MAGIC) >>> 0, 28);
    socket.send(res, rinfo.port, rinfo.address);
  });
  await new Promise<void>((r) => socket.bind(0, '127.0.0.1', r));
  state.url = `stun:127.0.0.1:${socket.address().port}`;
  return state;
}

const sockets: Socket[] = [];
afterEach(() => {
  for (const s of sockets.splice(0)) s.close();
});

describe('discoverPublicIpv4', () => {
  it('reads the XOR-MAPPED-ADDRESS of the answer', async () => {
    const stun = await fakeStun(() => '198.51.100.23');
    sockets.push(stun.socket);
    expect(await discoverPublicIpv4(stun.url, 2000)).toBe('198.51.100.23');
  });

  it('gives null when nothing answers in time', async () => {
    const stun = await fakeStun(() => null);
    sockets.push(stun.socket);
    const started = Date.now();
    expect(await discoverPublicIpv4(stun.url, 300)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(stun.requests).toBeGreaterThan(0);
  });

  it('gives null for a URL that is not stun:host:port', async () => {
    expect(await discoverPublicIpv4('turn:127.0.0.1:3478', 100)).toBeNull();
  });
});

describe('advertisable', () => {
  it('refuses Docker and Tailscale ranges and anything not IPv4', () => {
    expect(advertisable('203.0.113.9')).toBe(true);
    expect(advertisable('192.168.1.98')).toBe(true);
    expect(advertisable('127.0.0.1')).toBe(true);
    expect(advertisable('172.16.0.1')).toBe(false);
    expect(advertisable('172.31.255.254')).toBe(false);
    expect(advertisable('172.32.0.1')).toBe(true);
    expect(advertisable('100.64.0.1')).toBe(false);
    expect(advertisable('100.127.255.255')).toBe(false);
    expect(advertisable('100.128.0.1')).toBe(true);
    expect(advertisable('fe80::1')).toBe(false);
    expect(advertisable('1.2.3')).toBe(false);
  });
});

describe('AddressAdvertiser', () => {
  it('advertises the public address and the LAN address, and follows a change on the next refresh', async () => {
    let answer = '198.51.100.23';
    const stun = await fakeStun(() => answer);
    sockets.push(stun.socket);
    const advertiser = new AddressAdvertiser({ log: () => {}, stun: stun.url, lan: '192.168.1.98', timeoutMs: 1000 });
    expect(advertiser.advertise()).toEqual(['192.168.1.98']);
    await advertiser.refresh();
    expect(advertiser.advertise()).toEqual(['198.51.100.23', '192.168.1.98']);
    answer = '203.0.113.40';
    await advertiser.refresh();
    expect(advertiser.advertise()).toEqual(['203.0.113.40', '192.168.1.98']);
  });

  it('keeps the last public address when a refresh gets no answer', async () => {
    let answer: string | null = '198.51.100.23';
    const stun = await fakeStun(() => answer);
    sockets.push(stun.socket);
    const advertiser = new AddressAdvertiser({ log: () => {}, stun: stun.url, timeoutMs: 200 });
    await advertiser.refresh();
    answer = null;
    await advertiser.refresh();
    expect(advertiser.advertise()).toEqual(['198.51.100.23']);
  });

  it('never advertises a Docker or Tailscale address STUN reports', async () => {
    const stun = await fakeStun(() => '172.18.0.5');
    sockets.push(stun.socket);
    const advertiser = new AddressAdvertiser({ log: () => {}, stun: stun.url, timeoutMs: 1000 });
    await advertiser.refresh();
    expect(advertiser.advertise()).toEqual([]);
  });

  it('runs at start and then on every interval until stopped', async () => {
    let answer = '198.51.100.23';
    const stun = await fakeStun(() => answer);
    sockets.push(stun.socket);
    const advertiser = new AddressAdvertiser({ log: () => {}, stun: stun.url, timeoutMs: 1000, intervalMs: 50 });
    await advertiser.start();
    expect(advertiser.advertise()).toEqual(['198.51.100.23']);
    answer = '203.0.113.40';
    await expect.poll(() => advertiser.advertise(), { timeout: 2000 }).toEqual(['203.0.113.40']);
    advertiser.stop();
  });

  it('advertises a fixed list instead of discovering', async () => {
    const advertiser = new AddressAdvertiser({ stun: 'stun:127.0.0.1:9', fixed: ['127.0.0.1'] });
    await advertiser.start();
    expect(advertiser.advertise()).toEqual(['127.0.0.1']);
    advertiser.stop();
  });
});
