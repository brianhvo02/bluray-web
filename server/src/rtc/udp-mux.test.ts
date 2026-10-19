import { createHmac, randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import type { Socket } from 'node:dgram';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MuxConflict, stunIntegrityVerifies, UdpMux } from './udp-mux';
import type { MuxOwner, MuxTransport } from './udp-mux';

// Port 47990 is this file's own (the tests' range is 47990–47997).
const PORT = 47990;

/** A STUN Binding request with USERNAME and a MESSAGE-INTEGRITY under `password` (corrupted when `forge`). */
function bindingRequest(username: string, password: string, opts: { forge?: boolean; txid?: Buffer } = {}): Buffer {
  const name = Buffer.from(username);
  const padded = (name.length + 3) & ~3;
  const usernameAttr = Buffer.alloc(4 + padded);
  usernameAttr.writeUInt16BE(0x0006, 0);
  usernameAttr.writeUInt16BE(name.length, 2);
  name.copy(usernameAttr, 4);
  const header = Buffer.alloc(20);
  header.writeUInt16BE(0x0001, 0);
  header.writeUInt16BE(usernameAttr.length + 24, 2);
  header.writeUInt32BE(0x2112a442, 4);
  (opts.txid ?? randomBytes(12)).copy(header, 8);
  const mac = createHmac('sha1', password).update(Buffer.concat([header, usernameAttr])).digest();
  if (opts.forge) mac[0]! ^= 0xff;
  const integrity = Buffer.alloc(24);
  integrity.writeUInt16BE(0x0008, 0);
  integrity.writeUInt16BE(20, 2);
  mac.copy(integrity, 4);
  return Buffer.concat([header, usernameAttr, integrity]);
}

/** A Binding success response to `txid`, with no attributes. */
function bindingResponse(txid: Buffer): Buffer {
  const res = Buffer.alloc(20);
  res.writeUInt16BE(0x0101, 0);
  res.writeUInt32BE(0x2112a442, 4);
  txid.copy(res, 8);
  return res;
}

const DTLS = Buffer.from([22, 254, 253, 0, 0, 0, 0, 0, 0, 0, 1]);

let mux: UdpMux;
const senders: Socket[] = [];

async function sender(): Promise<{ socket: Socket; port: number; send(data: Buffer): Promise<void> }> {
  const socket = createSocket('udp4');
  senders.push(socket);
  await new Promise<void>((r) => socket.bind(0, '127.0.0.1', r));
  return {
    socket,
    port: socket.address().port,
    send: (data) => new Promise((r) => socket.send(data, PORT, '127.0.0.1', () => r())),
  };
}

/** A transport for `owner` that records what reaches it. */
function listen(owner: MuxOwner): { transport: MuxTransport; got: Buffer[] } {
  const transport = owner.transport();
  const got: Buffer[] = [];
  transport.onData = (data) => got.push(data);
  return { transport, got };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

beforeEach(async () => {
  mux = await UdpMux.open(PORT);
});

afterEach(async () => {
  for (const s of senders.splice(0)) s.close();
  await mux.close();
});

describe('UdpMux', () => {
  it('routes a verified check to its connection, then that address’s other packets; a stray datagram goes nowhere', async () => {
    const a = mux.owner();
    a.claim('nasA', 'devA', 'pwd-a-0123456789abcdef');
    const ra = listen(a);
    const b = mux.owner();
    b.claim('nasB', 'devB', 'pwd-b-0123456789abcdef');
    const rb = listen(b);
    const device = await sender();
    const stranger = await sender();

    await stranger.send(DTLS);
    await device.send(DTLS); // before any check: unknown address
    await settle();
    expect(ra.got).toHaveLength(0);
    expect(rb.got).toHaveLength(0);

    await device.send(bindingRequest('nasA:devA', 'pwd-a-0123456789abcdef'));
    await device.send(DTLS);
    await stranger.send(DTLS);
    await settle();
    expect(ra.got).toHaveLength(2);
    expect(ra.got[1]!.equals(DTLS)).toBe(true);
    expect(rb.got).toHaveLength(0);
  });

  it('ignores a check whose MESSAGE-INTEGRITY does not verify, and it moves no address', async () => {
    const a = mux.owner();
    a.claim('nasA', 'devA', 'pwd-a-0123456789abcdef');
    const ra = listen(a);
    const b = mux.owner();
    b.claim('nasB', 'devB', 'pwd-b-0123456789abcdef');
    const rb = listen(b);
    const device = await sender();
    await device.send(bindingRequest('nasA:devA', 'pwd-a-0123456789abcdef'));
    await settle();

    await device.send(bindingRequest('nasB:devB', 'pwd-b-0123456789abcdef', { forge: true }));
    await device.send(bindingRequest('nasB:devB', 'pwd-a-0123456789abcdef')); // the wrong connection's password
    await device.send(DTLS);
    await settle();
    expect(rb.got).toHaveLength(0);
    expect(ra.got).toHaveLength(2);
  });

  it('moves an address on a verified check from another connection', async () => {
    const a = mux.owner();
    a.claim('nasA', 'devA', 'pwd-a-0123456789abcdef');
    const ra = listen(a);
    const b = mux.owner();
    b.claim('nasB', 'devB', 'pwd-b-0123456789abcdef');
    const rb = listen(b);
    const device = await sender();
    await device.send(bindingRequest('nasA:devA', 'pwd-a-0123456789abcdef'));
    await device.send(bindingRequest('nasB:devB', 'pwd-b-0123456789abcdef'));
    await device.send(DTLS);
    await settle();
    expect(ra.got).toHaveLength(1);
    expect(rb.got).toHaveLength(2);
  });

  it('does not let a send take an address another live connection holds', async () => {
    const a = mux.owner();
    a.claim('nasA', 'devA', 'pwd-a-0123456789abcdef');
    const ra = listen(a);
    const b = mux.owner();
    b.claim('nasB', 'devB', 'pwd-b-0123456789abcdef');
    const rb = listen(b);
    const device = await sender();
    await device.send(bindingRequest('nasA:devA', 'pwd-a-0123456789abcdef'));
    await settle();
    await rb.transport.send(DTLS, ['127.0.0.1', device.port]);
    await device.send(DTLS);
    await settle();
    expect(ra.got).toHaveLength(2);
    expect(rb.got).toHaveLength(0);
  });

  it('routes a STUN response by its transaction id, and drops one for an unknown transaction', async () => {
    const a = mux.owner();
    a.claim('nasA', 'devA', 'pwd-a-0123456789abcdef');
    const ra = listen(a);
    const device = await sender();
    const txid = randomBytes(12);
    await ra.transport.send(bindingRequest('devA:nasA', 'pwd-device', { txid }), ['127.0.0.1', device.port]);
    await device.send(bindingResponse(randomBytes(12)));
    await device.send(bindingResponse(txid));
    await settle();
    expect(ra.got).toHaveLength(1);
    expect(ra.got[0]!.subarray(8, 20).equals(txid)).toBe(true);
  });

  it('drops a closed connection’s packets', async () => {
    const a = mux.owner();
    a.claim('nasA', 'devA', 'pwd-a-0123456789abcdef');
    const ra = listen(a);
    const device = await sender();
    await device.send(bindingRequest('nasA:devA', 'pwd-a-0123456789abcdef'));
    await settle();
    a.close();
    await device.send(DTLS);
    await device.send(bindingRequest('nasA:devA', 'pwd-a-0123456789abcdef'));
    await settle();
    expect(ra.got).toHaveLength(1);
  });

  it('refuses a username a live connection holds, and frees it when that one closes', async () => {
    const a = mux.owner();
    a.claim('nasA', 'devA', 'pwd-a');
    const b = mux.owner();
    expect(() => b.claim('nasA', 'devA', 'pwd-b')).toThrow(MuxConflict);
    b.claim('nasA', 'devOther', 'pwd-b'); // the same ufrag with another device is another username
    a.close();
    mux.owner().claim('nasA', 'devA', 'pwd-c');
  });

  it('gives a closed transport to a connection that already closed', () => {
    const a = mux.owner();
    a.close();
    const transport = a.transport();
    expect(transport.closed).toBe(true);
    expect(a.transports.size).toBe(0);
  });
});

describe('stunIntegrityVerifies', () => {
  it('checks the HMAC-SHA1 over the message up to MESSAGE-INTEGRITY', () => {
    expect(stunIntegrityVerifies(bindingRequest('a:b', 'secret'), 'secret')).toBe(true);
    expect(stunIntegrityVerifies(bindingRequest('a:b', 'secret'), 'other')).toBe(false);
    expect(stunIntegrityVerifies(bindingRequest('a:b', 'secret', { forge: true }), 'secret')).toBe(false);
    expect(stunIntegrityVerifies(bindingResponse(randomBytes(12)), 'secret')).toBe(false);
  });
});
