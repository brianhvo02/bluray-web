import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DiscEntry } from '../../../src/engine/disc/nas-api';
import { buildIndex, buildMpls } from '../../../tests/helpers/bdmv-builders';
import { IsoTrees } from '../iso';
import { catalogueNumbers, readFolderEvidence, readIsoEvidence } from './evidence';

const FIXTURES = join(import.meta.dirname, '../../../fixtures/synthetic');
let tmp: string;

const put = (path: string, bytes: Uint8Array | string): void => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, bytes);
};
const bdmt = (lang: string, name: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>\n<disclib xmlns="urn:BDA:bdmv;disclib" xmlns:di="urn:BDA:bdmv;discinfo">\n` +
  `<di:discinfo><di:title><di:name>${name}</di:name><di:alternative>x</di:alternative></di:title>` +
  `<di:language>${lang}</di:language></di:discinfo></disclib>\n`;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'evidence-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('readFolderEvidence', () => {
  const rel = 'drv0-dl/[BDMV][Foo][Vol.1-6 Fin]/Vol.3/BD';
  const entry: DiscEntry = { id: 'disc-3', name: 'BD', path: rel, kind: 'folder', sizeBytes: 0 };

  beforeEach(() => {
    const bdmv = join(tmp, 'BD/BDMV');
    put(join(bdmv, 'index.bdmv'), buildIndex({ firstPlay: { kind: 'hdmv', movieObjectId: 0 }, topMenu: { kind: 'hdmv', movieObjectId: 0 }, titles: [] }));
    // 00001: two play items of 600 s and 30 s, three entry marks and one link mark.
    put(
      join(bdmv, 'PLAYLIST/00001.mpls'),
      buildMpls({
        playItems: [
          { clipId: '00001', inTime: 45_000, outTime: 45_000 + 600 * 45_000 },
          { clipId: '00002', inTime: 0, outTime: 30 * 45_000 },
        ],
        marks: [
          { playItemRef: 0, time: 45_000 },
          { playItemRef: 0, time: 45_000 * 300 },
          { playItemRef: 1, time: 0 },
          { playItemRef: 1, time: 45_000, type: 2 },
        ],
      }),
    );
    put(join(bdmv, 'PLAYLIST/00002.MPLS'), buildMpls({ playItems: [{ clipId: '00002', inTime: 0, outTime: 22_500 }] }));
    put(join(bdmv, 'PLAYLIST/00003.mpls'), 'not a playlist');
    put(join(bdmv, 'STREAM/00002.m2ts'), new Uint8Array(3));
    put(join(bdmv, 'STREAM/00001.m2ts'), new Uint8Array(5));
    put(join(bdmv, 'META/DL/bdmt_jpn.xml'), bdmt('jpn', 'フー &amp; バー 第3巻'));
    put(join(bdmv, 'META/DL/BDMT_ENG.XML'), bdmt('eng', ' Foo &amp; Bar Vol.3 [EFGH-1234] '));
    put(join(bdmv, 'META/DL/thumb.jpg'), 'jpeg');
  });

  it('records titles, segments, playlists, the fingerprint and catalogue numbers', async () => {
    const ev = await readFolderEvidence(entry, join(tmp, 'BD'));
    expect(ev.discId).toBe('disc-3');
    expect(ev.path).toBe(rel);
    expect(ev.discTitles).toEqual([
      { lang: 'eng', name: 'Foo & Bar Vol.3 [EFGH-1234]' },
      { lang: 'jpn', name: 'フー & バー 第3巻' },
    ]);
    expect(ev.segments).toEqual(['[BDMV][Foo][Vol.1-6 Fin]', 'Vol.3', 'BD']);
    expect(ev.playlists).toEqual([
      { id: '00001', durationS: 630, chapters: 3, clips: ['00001', '00002'] },
      { id: '00002', durationS: 0.5, chapters: 0, clips: ['00002'] },
    ]);
    // 00001.m2ts (5 bytes) then 00002.m2ts (3 bytes).
    expect(ev.fingerprint).toBe('656406AF0870C6AEF535497CA7F1C439');
    expect(ev.catalogueNumbers).toEqual(['EFGH-1234']);
  });

  it('copes with a disc that has no playlists, streams or metadata', async () => {
    put(join(tmp, 'Bare/BDMV/index.bdmv'), 'x');
    const ev = await readFolderEvidence({ ...entry, path: 'drv0/Bare' }, join(tmp, 'Bare'));
    expect(ev).toEqual({ discId: 'disc-3', path: 'drv0/Bare', fingerprint: null, discTitles: [], segments: ['Bare'], catalogueNumbers: [], playlists: [] });
  });
});

describe('readIsoEvidence', () => {
  it('reads an ISO disc like its folder', async () => {
    const abs = join(FIXTURES, 'disc1.iso');
    const entry: DiscEntry = { id: 'iso-1', name: 'disc1.iso', path: 'drv0/Foo/disc1.iso', kind: 'iso', sizeBytes: 0 };
    const iso = await readIsoEvidence(entry, abs, await new IsoTrees().get('iso-1', abs));
    const folder = await readFolderEvidence({ ...entry, kind: 'folder' }, join(FIXTURES, 'disc1'));
    expect(iso.segments).toEqual(['Foo', 'disc1.iso']);
    expect(iso.fingerprint).toMatch(/^[0-9A-F]{32}$/);
    expect(iso.playlists.length).toBeGreaterThan(0);
    expect(iso).toEqual(folder);
  });
});

describe('catalogueNumbers', () => {
  it('finds catalogue numbers in names', () => {
    expect(catalogueNumbers('[BDMV][240315][EFGH-6789][白い鳥の約束]')).toEqual(['EFGH-6789']);
    expect(catalogueNumbers('ABCD-12345')).toEqual(['ABCD-12345']);
    expect(catalogueNumbers('MNOP 1357')).toEqual(['MNOP-1357']);
    expect(catalogueNumbers('XXCL-1234~5')).toEqual(['XXCL-1234']);
    expect(catalogueNumbers('ＡＢＣＤ－１２３４５ / ABCD-12345')).toEqual(['ABCD-12345']);
  });

  it('ignores dates, volumes and technical tags', () => {
    expect(catalogueNumbers('[BDMV][Foo][Vol.1-6 Fin] Disc 2 1080p')).toEqual([]);
    expect(catalogueNumbers('[BDMV 2024] HEVC 2160 FLAC 2496 BD-1080 S01E02')).toEqual([]);
  });
});
