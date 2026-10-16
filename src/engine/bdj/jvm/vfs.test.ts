import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { syntheticSource } from '../../../../tests/helpers/synthetic-disc';
import { ZipArchive } from './zip';
import { Vfs } from './vfs';

const rtBdj = ZipArchive.open(readFileSync(fileURLToPath(new URL('../../../bdj-classlib/rt-bdj.jar', import.meta.url))));
const enc = new TextEncoder();
const dec = new TextDecoder();

function discFiles(): Map<string, Uint8Array<ArrayBuffer>> {
  const root = fileURLToPath(new URL('../../../../fixtures/synthetic/disc-bdj/', import.meta.url));
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  const put = (p: string): void => void files.set(p.toUpperCase(), new Uint8Array(readFileSync(root + p)));
  put('BDMV/JAR/00000.jar');
  put('BDMV/BDJO/00000.bdjo');
  put('BDMV/index.bdmv');
  for (const p of ['BDMV/JAR/00001/CONFIG.XML', 'BDMV/JAR/00001/IMG/X.PNG', 'BDMV/AUXDATA/SUB/F.OTF']) files.set(p, new Uint8Array([1, 2, 3]));
  return files;
}

function make(extra: Partial<ConstructorParameters<typeof Vfs>[0]> = {}): { vfs: Vfs; clock: { t: number } } {
  const clock = { t: 100 };
  const disc = syntheticSource(discFiles());
  const vfs = new Vfs({ disc, discPaths: disc.paths(), jdkLib: rtBdj, nowMs: () => clock.t, ...extra });
  return { vfs, clock };
}

function writeFile(vfs: Vfs, path: string, text: string, mode: 'w' | 'a' = 'w'): void {
  const h = vfs.open(path, mode)!;
  const b = enc.encode(text);
  expect(vfs.write(h, b, 0, b.length)).toBe(true);
  vfs.close(h);
}

function readAll(vfs: Vfs, path: string): string {
  const h = vfs.open(path, 'r')!;
  const out = new Uint8Array(h.size());
  expect(vfs.read(h, out, 0, out.length)).toBe(out.length);
  return dec.decode(out);
}

describe('/disc/', () => {
  it('finds files case-insensitively', () => {
    const { vfs } = make();
    expect(vfs.stat('/disc/BDMV/JAR/00000.jar')?.kind).toBe('file');
    expect(vfs.stat('/disc/bdmv/jar/00000.JAR')?.size).toBe(discFiles().get('BDMV/JAR/00000.JAR')!.length);
    expect(vfs.stat('/disc/BDMV/JAR')?.kind).toBe('dir');
    expect(vfs.stat('/disc/BDMV/NOPE')).toBeNull();
  });

  it('lists with BD-ROM conventional spelling, and with the disc spelling when given', () => {
    const { vfs } = make();
    expect(vfs.list('/disc/BDMV/JAR')).toEqual(['00000.jar', '00001']);
    expect(vfs.list('/disc/bdmv/bdjo')).toEqual(['00000.bdjo']);
    expect(vfs.list('/disc/BDMV')).toEqual(['AUXDATA', 'BDJO', 'JAR', 'index.bdmv']);
    expect(vfs.list('/disc')).toEqual(['BDMV']);
    const originalNames = new Map([['BDMV/JAR/00000.JAR', 'Disc/bdmv/Jar/00000.JAR']]);
    const named = make({ originalNames }).vfs;
    expect(named.list('/disc/BDMV/JAR')).toEqual(['00000.JAR', '00001']);
    expect(named.list('/disc/BDMV')).toContain('Jar');
  });

  it('derives directories from the file set and round-trips list and stat', () => {
    const { vfs } = make();
    expect(vfs.list('/disc/BDMV/JAR')).toContain('00001');
    expect(vfs.stat('/disc/BDMV/JAR/00001/img')?.kind).toBe('dir');
    expect(vfs.list('/disc/BDMV/JAR/00001')).toEqual(['CONFIG.xml', 'IMG']);
    const walk = (dir: string): void => {
      for (const name of vfs.list(dir)!) {
        const child = `${dir}/${name}`;
        const st = vfs.stat(child);
        expect(st, child).not.toBeNull();
        if (st!.kind === 'dir') walk(child);
      }
    };
    walk('/disc');
  });

  it('reads through a promise and returns -1 at EOF', async () => {
    const { vfs } = make();
    const expected = discFiles().get('BDMV/JAR/00000.JAR')!;
    const h = vfs.open('/disc/bdmv/jar/00000.jar', 'r')!;
    const out = new Uint8Array(8);
    const p = vfs.read(h, out, 0, 8);
    expect(p).toBeInstanceOf(Promise);
    expect(await p).toBe(8);
    expect([...out]).toEqual([...expected.subarray(0, 8)]);
    h.position = expected.length - 3;
    expect(await vfs.read(h, out, 0, 8)).toBe(3);
    expect(await vfs.read(h, out, 0, 8)).toBe(-1);
  });

  it('refuses writes', () => {
    const { vfs } = make();
    expect(vfs.open('/disc/BDMV/JAR/00000.jar', 'w')).toBeNull();
    expect(vfs.open('/disc/BDMV/new', 'w')).toBeNull();
    const h = vfs.open('/disc/BDMV/JAR/00000.jar', 'r')!;
    expect(vfs.write(h, new Uint8Array(1), 0, 1)).toBe(false);
    expect(vfs.mkdir('/disc/x')).toBe(false);
    expect(vfs.delete('/disc/BDMV/JAR/00000.jar')).toBe(false);
    expect(vfs.rename('/disc/BDMV/index.bdmv', '/tmp/i')).toBe(false);
  });

  it('is empty without a disc', () => {
    const vfs = new Vfs({ disc: null, jdkLib: rtBdj, nowMs: () => 0 });
    expect(vfs.list('/disc')).toEqual([]);
    expect(vfs.stat('/disc/BDMV')).toBeNull();
  });
});

it('requires discPaths with a disc', () => {
  const disc = syntheticSource(discFiles());
  expect(() => new Vfs({ disc, jdkLib: rtBdj, nowMs: () => 0 })).toThrow(/discPaths/);
});

describe('/app/', () => {
  it('serves extra files read-only', () => {
    const app = new Map([['conformance.jar', enc.encode('PK')], ['sub/x.txt', enc.encode('x')]]);
    const { vfs } = make({ app });
    expect(readAll(vfs, '/app/conformance.jar')).toBe('PK');
    expect(vfs.list('/app')).toEqual(['conformance.jar', 'sub']);
    expect(vfs.list('/app/sub')).toEqual(['x.txt']);
    expect(vfs.open('/app/conformance.jar', 'w')).toBeNull();
  });
});

describe('memory mounts', () => {
  it('supports mkdir, nested files, sizes, append and mtime', () => {
    const { vfs, clock } = make();
    expect(vfs.mkdir('/tmp/a')).toBe(true);
    expect(vfs.mkdir('/tmp/a')).toBe(false);
    expect(vfs.mkdir('/tmp/x/y')).toBe(false);
    clock.t = 500;
    writeFile(vfs, '/tmp/a/f.txt', 'hello');
    expect(vfs.stat('/tmp/a/f.txt')).toEqual({ kind: 'file', size: 5, mtimeMs: 500 });
    clock.t = 600;
    writeFile(vfs, '/tmp/a/f.txt', ' world', 'a');
    expect(readAll(vfs, '/tmp/a/f.txt')).toBe('hello world');
    expect(vfs.stat('/tmp/a/f.txt')?.mtimeMs).toBe(600);
    writeFile(vfs, '/tmp/a/f.txt', 'x');
    expect(vfs.stat('/tmp/a/f.txt')?.size).toBe(1);
  });

  it('grows large writes and pads gaps with zeros', () => {
    const { vfs } = make();
    const h = vfs.open('/persistent/big', 'rw')!;
    h.position = 3;
    vfs.write(h, new Uint8Array(1000).fill(7), 0, 1000);
    expect(vfs.stat('/persistent/big')?.size).toBe(1003);
    const out = new Uint8Array(1003);
    h.position = 0;
    expect(vfs.read(h, out, 0, 1003)).toBe(1003);
    expect([out[0], out[2], out[3], out[1002]]).toEqual([0, 0, 7, 7]);
    expect(vfs.read(h, out, 0, 1)).toBe(-1);
  });

  it('truncates and zero-extends, sets mtimes, and says which paths are writable', () => {
    const { vfs } = make();
    writeFile(vfs, '/tmp/t', 'abcdef');
    const h = vfs.open('/tmp/t', 'rw')!;
    h.position = 5;
    expect(vfs.truncate(h, 2)).toBe(true);
    expect(h.position).toBe(2);
    expect(readAll(vfs, '/tmp/t')).toBe('ab');
    expect(vfs.truncate(h, 4)).toBe(true);
    expect(readAll(vfs, '/tmp/t')).toBe('ab\0\0');
    expect(vfs.truncate(vfs.open('/tmp/t', 'r')!, 0)).toBe(false);
    expect(vfs.setMtime('/tmp/t', 42)).toBe(true);
    expect(vfs.stat('/tmp/t')?.mtimeMs).toBe(42);
    expect(vfs.setMtime('/tmp/missing', 42)).toBe(false);
    expect(vfs.setMtime('/jdk/lib/currency.data', 42)).toBe(false);
    expect([vfs.writable('/tmp/x'), vfs.writable('/persistent/a/b'), vfs.writable('/tmp'), vfs.writable('/disc/BDMV'), vfs.writable('/jdk/x'), vfs.writable('/x')]).toEqual([
      true, true, false, false, false, false,
    ]);
  });

  it('lists sorted, renames across directories, refuses non-empty deletes', () => {
    const { vfs } = make();
    vfs.mkdir('/tmp/d1');
    vfs.mkdir('/tmp/d2');
    writeFile(vfs, '/tmp/d1/b', 'b');
    writeFile(vfs, '/tmp/d1/a', 'a');
    expect(vfs.list('/tmp/d1')).toEqual(['a', 'b']);
    expect(vfs.rename('/tmp/d1/a', '/tmp/d2/c')).toBe(true);
    expect(vfs.stat('/tmp/d1/a')).toBeNull();
    expect(readAll(vfs, '/tmp/d2/c')).toBe('a');
    expect(vfs.delete('/tmp/d1')).toBe(false);
    expect(vfs.delete('/tmp/d1/b')).toBe(true);
    expect(vfs.delete('/tmp/d1')).toBe(true);
    expect(vfs.rename('/tmp/d2', '/tmp/d2/inner')).toBe(false);
    expect(vfs.delete('/tmp')).toBe(false);
    expect(vfs.open('/tmp/d2', 'r')).toBeNull();
    expect(vfs.open('/tmp/missing', 'r')).toBeNull();
    expect(vfs.open('/tmp/nodir/f', 'w')).toBeNull();
  });
});

describe('/jdk/', () => {
  it('serves rt-bdj.jar lib entries', () => {
    const { vfs } = make();
    const expected = rtBdj.read('lib/tzdb.dat')!;
    expect(vfs.stat('/jdk/lib/tzdb.dat')).toEqual({ kind: 'file', size: expected.length, mtimeMs: 0 });
    expect(vfs.stat('/jdk/lib')?.kind).toBe('dir');
    expect(vfs.list('/jdk/lib')).toContain('tzdb.dat');
    expect(vfs.list('/jdk')).toEqual(['lib']);
    const h = vfs.open('/jdk/lib/tzdb.dat', 'r')!;
    const out = new Uint8Array(expected.length);
    expect(vfs.read(h, out, 0, out.length)).toBe(out.length);
    expect(out).toEqual(expected);
    expect(vfs.open('/jdk/lib/tzdb.dat', 'w')).toBeNull();
    expect(vfs.stat('/jdk/java/lang/Object.class')).toBeNull();
  });
});

describe('paths', () => {
  it('canonicalizes and confines to the mounts', () => {
    const { vfs } = make();
    expect(vfs.canonicalize('/tmp/a/../b//c/.')).toBe('/tmp/b/c');
    expect(vfs.canonicalize('/../../tmp')).toBe('/tmp');
    expect(vfs.canonicalize('/')).toBe('/');
    expect(vfs.stat('/etc/passwd')).toBeNull();
    expect(vfs.list('/etc')).toBeNull();
    expect(vfs.open('/etc/passwd', 'r')).toBeNull();
    expect(vfs.stat('/tmp/../etc')).toBeNull();
    expect(vfs.list('/')).toEqual(['app', 'buda', 'disc', 'jdk', 'persistent', 'tmp']);
    expect(vfs.mounts).toEqual(['/disc/', '/tmp/', '/persistent/', '/buda/', '/jdk/', '/app/']);
  });
});
