import { describe, expect, it } from 'vitest';
import type { DiscEntry, DiscManifest, FolderEntry } from '../../engine/disc/nas-api';
import { fakeNas } from '../../../tests/helpers/fake-nas';
import { fixtureDiscFiles } from '../../../tests/helpers/fixture-disc';
import { breadcrumbs, discBadges, discFacts, folderMemory, formatSize, openFailed, preflightLines, sortRows } from './library-model';

const folder = (name: string, path = `drv5/${name}`): FolderEntry => ({ name, path, discs: 1 });
const disc = (name: string, kind: DiscEntry['kind'] = 'folder', sizeBytes = 1): DiscEntry => ({ id: name, name, path: `drv5/${name}`, kind, sizeBytes });

/** disc1's manifest, its clip info changed by `patch` (the first clip's CLPI, 00001.clpi) and `patchSecond` (00002.clpi). */
function disc1Manifest(patch?: (clpi: Uint8Array) => void, patchSecond?: (clpi: Uint8Array) => void): DiscManifest {
  const files = fixtureDiscFiles('disc1');
  for (const id of ['00001', '00002']) setRecordingRate(6_000_000)(files.get(`BDMV/CLIPINF/${id}.clpi`)!);
  patch?.(files.get('BDMV/CLIPINF/00001.clpi')!);
  patchSecond?.(files.get('BDMV/CLIPINF/00002.clpi')!);
  return fakeNas(files).spec.manifest;
}

/** TS_recording_rate (bytes per second) at its fixed place in the ClipInfo. */
const setRecordingRate = (rate: number) => (clpi: Uint8Array) => new DataView(clpi.buffer, clpi.byteOffset).setUint32(52, rate);

/** The video stream's coding info (PID 0x1011, AVC 1080p) made HEVC 2160p. */
function makeUhd(clpi: Uint8Array): void {
  for (let i = 0; i + 4 < clpi.length; i++) {
    if (clpi[i] === 0x10 && clpi[i + 1] === 0x11 && clpi[i + 2] === 5 && clpi[i + 3] === 0x1b) {
      clpi[i + 3] = 0x24;
      clpi[i + 4] = (8 << 4) | (clpi[i + 4] & 0x0f);
      return;
    }
  }
  throw new Error('no video coding info found');
}

describe('breadcrumbs', () => {
  it('names the NAS, then each folder of the path', () => {
    const crumbs = breadcrumbs('drv5/[250226] きりの森');
    expect(crumbs.map((c) => c.label).join(' › ')).toBe('NAS › drv5 › [250226] きりの森');
    expect(crumbs.map((c) => c.path)).toEqual(['', 'drv5', 'drv5/[250226] きりの森']);
  });

  it('is just the NAS at the top', () => {
    expect(breadcrumbs('')).toEqual([{ label: 'NAS', path: '' }]);
  });

  it('keeps names with #, ?, % and + whole', () => {
    expect(breadcrumbs('drv0/a#1?/100% a+b').map((c) => c.label)).toEqual(['NAS', 'drv0', 'a#1?', '100% a+b']);
  });
});

describe('sortRows', () => {
  it('lists folders first, then discs, each in Japanese collation order', () => {
    const rows = sortRows({
      folders: [folder('鋼の旅団'), folder('Anime'), folder('あの丘')],
      discs: [disc('[BDMV] Rena - unknown'), disc('きりの森'), disc('Amber'), disc('10 Lanterns'), disc('2001')],
    });
    const names = (list: string[]) => [...list].sort((a, b) => a.localeCompare(b, 'ja'));
    expect(rows.map((r) => r.kind)).toEqual(['folder', 'folder', 'folder', 'disc', 'disc', 'disc', 'disc', 'disc']);
    expect(rows.slice(0, 3).map((r) => (r.kind === 'folder' ? r.folder.name : ''))).toEqual(names(['鋼の旅団', 'Anime', 'あの丘']));
    expect(rows.slice(3).map((r) => (r.kind === 'disc' ? r.disc.name : ''))).toEqual(names(['[BDMV] Rena - unknown', 'きりの森', 'Amber', '10 Lanterns', '2001']));
  });
});

describe('discBadges', () => {
  it('marks ISO images, and UHD once the manifest shows it', () => {
    expect(discBadges(disc('a'), undefined)).toEqual([]);
    expect(discBadges(disc('a', 'iso'), undefined)).toEqual(['ISO']);
    expect(discBadges(disc('a', 'iso'), true)).toEqual(['ISO', 'UHD']);
    expect(discBadges(disc('a'), false)).toEqual([]);
  });
});

describe('formatSize', () => {
  it('uses decimal units', () => {
    expect(formatSize(3_575_808)).toBe('3.6 MB');
    expect(formatSize(46_123_456_789)).toBe('46.1 GB');
    expect(formatSize(512)).toBe('512 B');
  });
});

describe('discFacts', () => {
  it("reads the main title's first clip: its peak rate (TS_recording_rate is bytes per second) and whether it is UHD", () => {
    expect(discFacts(disc1Manifest(setRecordingRate(6_000_000)))).toEqual({ peakMbps: 48, uhd: false });
    expect(discFacts(disc1Manifest((c) => (setRecordingRate(13_625_000)(c), makeUhd(c))))).toEqual({ peakMbps: 109, uhd: true });
  });

  it("takes the peak rate as the highest of the main title's clips", () => {
    // disc1's main title (00000) plays 00001 then 00002.
    expect(discFacts(disc1Manifest(undefined, setRecordingRate(10_000_000))).peakMbps).toBe(80);
    expect(discFacts(disc1Manifest(setRecordingRate(7_000_000), setRecordingRate(1_000_000))).peakMbps).toBe(56);
  });

  it('knows nothing of a disc whose playlists it cannot parse', () => {
    const files = [{ path: 'BDMV/PLAYLIST/00000.MPLS', size: 3 }];
    const manifest: DiscManifest = { discId: 'x', name: 'x', files, inline: { 'BDMV/PLAYLIST/00000.MPLS': 'AAAA' } };
    expect(discFacts(manifest)).toEqual({ peakMbps: null, uhd: false });
  });
});

describe('preflightLines', () => {
  it('shows the connection, and warns when the disc needs more', () => {
    expect(preflightLines(180.4, 48)).toEqual(['This connection: 180 Mbps']);
    expect(preflightLines(31.6, 48)).toEqual(['This connection: 32 Mbps', 'This disc needs about 48 Mbps; expect pauses.']);
    expect(preflightLines(31.6, null)).toEqual(['This connection: 32 Mbps']);
  });

  it('shows nothing without a measurement', () => {
    expect(preflightLines(null, 48)).toEqual([]);
  });
});

describe('folderMemory', () => {
  it('remembers the last folder, and starts at the top without one', () => {
    const items = new Map<string, string>();
    const storage = { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v) };
    const memory = folderMemory(storage);
    expect(memory.get()).toBe('');
    memory.set('drv5/[250226] きりの森');
    expect(folderMemory(storage).get()).toBe('drv5/[250226] きりの森');
  });

  it('works without storage, or when it throws', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    for (const storage of [undefined, throwing]) {
      const memory = folderMemory(storage);
      memory.set('drv0');
      expect(memory.get()).toBe('');
    }
  });
});

describe('openFailed', () => {
  it('is true once the engine reports an error for the disc being opened', () => {
    expect(openFailed({ engineState: 'loading', error: null })).toBe(false);
    expect(openFailed({ engineState: 'idle', error: null })).toBe(false);
    expect(openFailed({ engineState: 'error', error: null })).toBe(true);
    expect(openFailed({ engineState: 'loading', error: { code: 'disc-changed', message: 'x', paths: [] } })).toBe(true);
  });
});
