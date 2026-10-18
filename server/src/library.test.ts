import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { opendir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as udf from '../../src/engine/disc/udf';
import { discId } from './disc-id';
import { createServer } from './http';
import { Library, nextNightly } from './library';
import { libraryRoute } from './routes/library';

let tmp: string;
const FAST = { scanPauseMs: 0 };
const touch = (path: string, content = 'x'): void => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'library-'));
  const a = join(tmp, 'a');
  touch(join(a, 'Series (シリーズ)/Vol 1/BDMV/index.bdmv'));
  touch(join(a, 'Series (シリーズ)/Vol 1/BK/01.png'));
  touch(join(a, '[BDMV] Single #1 100%/bdmv/INDEX.BDMV'));
  touch(join(a, 'movie.mkv'));
  touch(join(a, 'x.torrent'));
  mkdirSync(join(a, 'lost+found'));
  copyFileSync(join(import.meta.dirname, '../../fixtures/synthetic/disc1.iso'), join(a, 'disc.iso'));
  touch(join(a, 'junk.iso'), 'iso-bytes'.repeat(100_000));
  touch(join(tmp, 'b/Other/BDMV/index.bdmv'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const roots = () => [
  { name: 'drvA', dir: join(tmp, 'a') },
  { name: 'drvB', dir: join(tmp, 'b') },
];

describe('Library', () => {
  it('merges roots and lists folders and discs', async () => {
    const lib = new Library(roots(), join(tmp, 'library.json'), FAST);
    await lib.scan();
    const top = lib.list('')!;
    expect(top.discs.map((d) => [d.name, d.path, d.kind])).toEqual([
      ['[BDMV] Single #1 100%', 'drvA/[BDMV] Single #1 100%', 'folder'],
      ['disc.iso', 'drvA/disc.iso', 'iso'],
      ['Other', 'drvB/Other', 'folder'],
    ]);
    expect(top.folders).toEqual([{ name: 'Series (シリーズ)', path: 'drvA/Series (シリーズ)', discs: 1 }]);
    const a = lib.list('drvA')!;
    expect(a.folders).toEqual([{ name: 'Series (シリーズ)', path: 'drvA/Series (シリーズ)', discs: 1 }]);
    expect(lib.list('drvA/Series (シリーズ)')).toMatchObject({ folders: [], discs: [{ name: 'Vol 1' }] });
    expect(lib.list('nope')).toBeNull();
  });

  it('keeps ids stable across scans and changes them when index.bdmv changes', async () => {
    const lib = new Library(roots(), join(tmp, 'library.json'), FAST);
    await lib.scan();
    const id = lib.list('drvB')!.discs[0]!.id;
    await lib.scan();
    expect(lib.list('drvB')!.discs[0]!.id).toBe(id);
    expect(lib.disc(id)?.name).toBe('Other');
    touch(join(tmp, 'b/Other/BDMV/index.bdmv'), 'longer content');
    await lib.scan();
    expect(lib.list('drvB')!.discs[0]!.id).not.toBe(id);
    expect(discId('p', 1, 2)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('loads the cache file at start', async () => {
    const file = join(tmp, 'library.json');
    await new Library(roots(), file, FAST).scan();
    const fresh = new Library(roots(), file, FAST);
    expect(fresh.list('drvB')!.discs).toHaveLength(1);
  });

  it('answers from the previous tree while a scan is running', async () => {
    const file = join(tmp, 'library.json');
    await new Library(roots(), file, FAST).scan();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const lib = new Library(roots(), file, { ...FAST, opendir: async (p) => (await gate, opendir(p)) });
    const scan = lib.scan();
    expect(lib.scanning).toBe(true);
    expect(lib.list('')!.discs).toHaveLength(3);
    release();
    await scan;
    expect(lib.scanning).toBe(false);
  });
});

describe('Library scan behaviour', () => {
  const streamOf = (): string => join(tmp, 'a/[BDMV] Single #1 100%/bdmv/STREAM');

  it('does not read STREAM again for an unchanged disc and keeps its size', async () => {
    touch(join(streamOf(), '00001.m2ts'), '12345');
    const opened: string[] = [];
    const spy = async (p: string) => (opened.push(p), opendir(p));
    const lib = new Library(roots(), join(tmp, 'library.json'), { ...FAST, opendir: spy });
    await lib.scan();
    const size = lib.list('drvA')!.discs.find((d) => d.name.startsWith('[BDMV]'))!.sizeBytes;
    expect(size).toBe(5);
    expect(opened.some((p) => p.endsWith('STREAM'))).toBe(true);
    opened.length = 0;
    await lib.scan();
    expect(opened.some((p) => p.endsWith('STREAM'))).toBe(false);
    expect(lib.list('drvA')!.discs.find((d) => d.name.startsWith('[BDMV]'))!.sizeBytes).toBe(5);
  });

  it('spaces directory reads by scanPauseMs', async () => {
    const times: number[] = [];
    const spy = async (p: string) => {
      times.push(Date.now());
      return opendir(p);
    };
    const lib = new Library(roots(), join(tmp, 'library.json'), { scanPauseMs: 30, opendir: spy });
    await lib.scan();
    expect(times.length).toBeGreaterThan(4);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(25);
  });

  it('keeps a root previous entries when its top-level read fails', async () => {
    const file = join(tmp, 'library.json');
    await new Library(roots(), file, FAST).scan();
    const bDir = join(tmp, 'b');
    const lib = new Library(roots(), file, {
      ...FAST,
      opendir: async (p) => {
        if (p === bDir) throw new Error('EIO');
        return opendir(p);
      },
    });
    await lib.scan();
    expect(lib.list('drvB')!.discs.map((d) => d.name)).toEqual(['Other']);
    expect(new Library(roots(), file, FAST).list('drvB')!.discs).toHaveLength(1);
  });

  it('keeps a root previous entries when it lists zero entries (a drive that is not mounted)', async () => {
    const file = join(tmp, 'library.json');
    await new Library(roots(), file, FAST).scan();
    const bDir = join(tmp, 'b');
    rmSync(bDir, { recursive: true });
    mkdirSync(bDir);
    const lib = new Library(roots(), file, FAST);
    await lib.scan();
    expect(lib.list('drvB')!.discs.map((d) => d.name)).toEqual(['Other']);
    expect(new Library(roots(), file, FAST).list('drvB')!.discs).toHaveLength(1);
  });

  it('installs the tree after each root on a first scan', async () => {
    const bDir = join(tmp, 'b');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const lib = new Library(roots(), join(tmp, 'library.json'), {
      ...FAST,
      opendir: async (p) => {
        if (p === bDir) await gate;
        return opendir(p);
      },
    });
    const scan = lib.scan();
    await vi.waitFor(() => expect(lib.list('')!.discs.length).toBe(2));
    release();
    await scan;
    expect(lib.list('')!.discs).toHaveLength(3);
  });

  it('does not descend into a BDMV folder without index.bdmv', async () => {
    touch(join(tmp, 'a/Odd/BDMV/Nested/BDMV/index.bdmv'));
    const lib = new Library(roots(), join(tmp, 'library.json'), FAST);
    await lib.scan();
    expect(lib.list('drvA/Odd')).toBeNull();
  });

  it('lists an .iso only when its UDF tree has BDMV/INDEX.BDMV, and reads each image once', async () => {
    touch(join(tmp, 'a/no-bdmv.iso'), '');
    const lib = new Library(roots(), join(tmp, 'library.json'), FAST);
    await lib.scan();
    const isos = lib.list('drvA')!.discs.filter((d) => d.kind === 'iso');
    expect(isos.map((d) => d.name)).toEqual(['disc.iso']);
    expect(isos[0]!.sizeBytes).toBe(statSync(join(tmp, 'a/disc.iso')).size);
    const reads = vi.spyOn(udf.UdfImage, 'open');
    await lib.scan();
    expect(reads).not.toHaveBeenCalled();
    expect(lib.list('drvA')!.discs.filter((d) => d.kind === 'iso').map((d) => d.name)).toEqual(['disc.iso']);
    reads.mockRestore();
  });

  it('drops invalid cache entries and entries of unconfigured roots', () => {
    const file = join(tmp, 'library.json');
    const good = { id: 'a', name: 'X', path: 'drvA/X', kind: 'folder', sizeBytes: 1 };
    writeFileSync(
      file,
      JSON.stringify([good, { ...good, id: 'b', path: 'gone/X' }, { ...good, id: 'c', kind: 'zip' }, { id: 'd' }, null, { ...good, id: 'e', path: 5 }]),
    );
    const lib = new Library(roots(), file, FAST);
    expect(lib.list('')!.discs).toEqual([good]);
  });
});

describe('nextNightly', () => {
  it('honours a configured time', () => {
    expect(nextNightly(new Date('2026-10-17T03:59:00'), { hour: 3, minute: 30 })).toEqual(new Date('2026-10-18T03:30:00'));
  });

  it('is 04:00 today before 04:00 and tomorrow from 04:00', () => {
    expect(nextNightly(new Date('2026-10-17T03:59:00'))).toEqual(new Date('2026-10-17T04:00:00'));
    expect(nextNightly(new Date('2026-10-17T04:00:00'))).toEqual(new Date('2026-10-18T04:00:00'));
  });
});

describe('GET /api/library', () => {
  it('round-trips awkward folder names exactly', async () => {
    const nfd = 'が'.normalize('NFD');
    touch(join(tmp, `a/A+B #1 100%?/Vol/BDMV/index.bdmv`));
    touch(join(tmp, `a/${nfd}/Vol/BDMV/index.bdmv`));
    const lib = new Library(roots(), join(tmp, 'library.json'), FAST);
    await lib.scan();
    const server = createServer([libraryRoute(lib)]);
    await new Promise<void>((r) => server.listen(0, r));
    try {
      const port = (server.address() as AddressInfo).port;
      for (const name of ['A+B #1 100%?', nfd]) {
        const listed = lib.list('drvA')!.folders.find((f) => f.name === name);
        expect(listed?.path).toBe(`drvA/${name}`);
        const res = await fetch(`http://127.0.0.1:${port}/api/library?path=${encodeURIComponent(`drvA/${name}`)}`);
        expect(res.status).toBe(200);
        expect(((await res.json()) as { discs: { path: string }[] }).discs[0]!.path).toBe(`drvA/${name}/Vol`);
      }
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });

  it('answers a percent-encoded folder path', async () => {
    const lib = new Library(roots(), join(tmp, 'library.json'), FAST);
    await lib.scan();
    const server = createServer([libraryRoute(lib)]);
    await new Promise<void>((r) => server.listen(0, r));
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/library?path=${encodeURIComponent('drvA/Series (シリーズ)')}`);
      const body = (await res.json()) as { discs: { name: string }[]; scanning: boolean };
      expect(body.discs.map((d) => d.name)).toEqual(['Vol 1']);
      expect(body.scanning).toBe(false);
      expect((await fetch(`http://127.0.0.1:${port}/api/library?path=zzz`)).status).toBe(404);
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });
});
