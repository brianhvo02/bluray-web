import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { opendir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discId } from './disc-id';
import { createServer } from './http';
import { Library, nextNightly } from './library';
import { libraryRoute } from './routes/library';

let tmp: string;
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
  touch(join(a, 'disc.iso'), 'iso-bytes');
  touch(join(tmp, 'b/Other/BDMV/index.bdmv'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const roots = () => [
  { name: 'drvA', dir: join(tmp, 'a') },
  { name: 'drvB', dir: join(tmp, 'b') },
];

describe('Library', () => {
  it('merges roots and lists folders and discs', async () => {
    const lib = new Library(roots(), join(tmp, 'library.json'));
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
    const lib = new Library(roots(), join(tmp, 'library.json'));
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
    await new Library(roots(), file).scan();
    const fresh = new Library(roots(), file);
    expect(fresh.list('drvB')!.discs).toHaveLength(1);
  });

  it('answers from the previous tree while a scan is running', async () => {
    const file = join(tmp, 'library.json');
    await new Library(roots(), file).scan();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const lib = new Library(roots(), file, { opendir: async (p) => (await gate, opendir(p)) });
    const scan = lib.scan();
    expect(lib.scanning).toBe(true);
    expect(lib.list('')!.discs).toHaveLength(3);
    release();
    await scan;
    expect(lib.scanning).toBe(false);
  });
});

describe('nextNightly', () => {
  it('is 04:00 today before 04:00 and tomorrow from 04:00', () => {
    expect(nextNightly(new Date('2026-10-17T03:59:00'))).toEqual(new Date('2026-10-17T04:00:00'));
    expect(nextNightly(new Date('2026-10-17T04:00:00'))).toEqual(new Date('2026-10-18T04:00:00'));
  });
});

describe('GET /api/library', () => {
  it('answers a percent-encoded folder path', async () => {
    const lib = new Library(roots(), join(tmp, 'library.json'));
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
