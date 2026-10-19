import { describe, expect, it } from 'vitest';
import { EMPTY_TAR, listTar, TarError, writeTar } from './tar.js';

/** Builds one raw ustar header with a valid checksum, for entries `writeTar` refuses to write. */
function rawEntry(opts: { name?: string; prefix?: string; type?: string; size?: number; body?: Buffer }): Buffer {
  const body = opts.body ?? Buffer.alloc(0);
  const h = Buffer.alloc(512);
  h.write(opts.name ?? 'a.txt', 0);
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write((opts.size ?? body.length).toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write(opts.type ?? '0', 156);
  h.write('ustar\0' + '00', 257);
  h.write(opts.prefix ?? '', 345);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([h, body, Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length)]);
}

const withEnd = (...parts: Buffer[]): Buffer => Buffer.concat([...parts, EMPTY_TAR]);

describe('tar', () => {
  it('round-trips paths, sizes and mtimes', () => {
    const long = `${'d'.repeat(90)}/${'e'.repeat(90)}/f.bin`;
    const files = [
      { path: 'a.txt', data: Buffer.from('hello'), mtime: 1_700_000_000 },
      { path: 'dir/b.bin', data: Buffer.alloc(1024, 7), mtime: 5 },
      { path: long, data: Buffer.alloc(0), mtime: 0 },
    ];
    expect(listTar(writeTar(files))).toEqual(files.map((f) => ({ path: f.path, size: f.data.length, mtime: f.mtime })));
  });

  it('lists an empty archive as nothing', () => {
    expect(EMPTY_TAR.length).toBe(1024);
    expect(listTar(EMPTY_TAR)).toEqual([]);
  });

  it.each([
    ['dot-dot', '../x'],
    ['absolute', '/abs'],
    ['nested dot-dot', 'a/../../b'],
  ])('rejects a %s path', (_n, name) => {
    expect(() => listTar(withEnd(rawEntry({ name })))).toThrow(TarError);
  });

  it('rejects a symlink and a directory', () => {
    expect(() => listTar(withEnd(rawEntry({ type: '2' })))).toThrow(TarError);
    expect(() => listTar(withEnd(rawEntry({ type: '5', name: 'd/' })))).toThrow(TarError);
  });

  it('rejects a size past the end and a truncated body', () => {
    expect(() => listTar(rawEntry({ size: 100000 }))).toThrow(TarError);
    const ok = withEnd(rawEntry({ body: Buffer.alloc(2000, 1) }));
    expect(() => listTar(ok.subarray(0, 512 + 1000))).toThrow(TarError);
  });

  it('rejects a bad checksum and a missing end', () => {
    const bad = withEnd(rawEntry({}));
    bad[0] = bad[0]! ^ 1;
    expect(() => listTar(bad)).toThrow(TarError);
    expect(() => listTar(rawEntry({}))).toThrow(TarError);
    expect(() => listTar(Buffer.alloc(512))).toThrow(TarError);
  });

  it('rejects a path past 255 bytes, in the reader and the writer', () => {
    const prefix = 'p'.repeat(155);
    expect(listTar(withEnd(rawEntry({ name: 'n'.repeat(99), prefix })))[0]!.path.length).toBe(255);
    expect(() => listTar(withEnd(rawEntry({ name: 'n'.repeat(100), prefix })))).toThrow(TarError);
    expect(() => writeTar([{ path: 'x'.repeat(300), data: Buffer.alloc(0), mtime: 0 }])).toThrow(TarError);
  });

  it.each([['x'], ['g'], ['L']])('rejects typeflag %s', (type) => {
    expect(() => listTar(withEnd(rawEntry({ type })))).toThrow(TarError);
  });

  it('rejects a base-256 size and an all-NUL mtime', () => {
    const big = rawEntry({});
    big[124] = 0x80;
    expect(() => listTar(withEnd(big))).toThrow(TarError);
    const noTime = rawEntry({});
    noTime.fill(0, 136, 148);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : noTime[i]!;
    noTime.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    expect(() => listTar(withEnd(noTime))).toThrow(TarError);
  });

  it('requires the ustar magic', () => {
    const h = rawEntry({});
    h.fill(0, 257, 263);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    expect(() => listTar(withEnd(h))).toThrow(TarError);
  });

  it.each([['a//b'], ['./a'], ['a/./b'], ['a/']])('rejects the path %s', (name) => {
    expect(() => listTar(withEnd(rawEntry({ name })))).toThrow(TarError);
  });

  it('rejects duplicate paths and invalid UTF-8', () => {
    expect(() => listTar(withEnd(rawEntry({}), rawEntry({})))).toThrow(TarError);
    const h = rawEntry({});
    h[0] = 0xff;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    expect(() => listTar(withEnd(h))).toThrow(TarError);
  });

  it('refuses to write a value that does not fit a header field', () => {
    expect(() => writeTar([{ path: 'a', data: Buffer.alloc(0), mtime: -1 }])).toThrow(TarError);
    expect(() => writeTar([{ path: 'a', data: Buffer.alloc(0), mtime: 1.5 }])).toThrow(TarError);
    expect(() => writeTar([{ path: 'a', data: Buffer.alloc(0), mtime: 8 ** 11 }])).toThrow(TarError);
  });
});
