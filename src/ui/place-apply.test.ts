import { describe, expect, it } from 'vitest';
import type { PlaceSettings } from '../engine/disc/nas-api';
import type { SubtitleChoice, TextFileInfo } from '../engine/protocol';
import { INITIAL_SNAPSHOT, type PlayerSnapshot } from '../player/player-controller';
import { filesToAdd, LaunchSettingsApplier } from './place-apply';
import type { LaunchSettings } from './place-saver';
import type { StoredTextFile } from './place-store';

const KEY = `f.${'A'.repeat(32)}`;
const base: PlaceSettings = {
  audioLanguage: 'jpn', pgLanguage: null, textFiles: [], psr1: 1, psr2: 0, psr3: 1, textOn: false, textScale: 1, shaderSet: null, volume: 1, muted: false,
};
const bytes = (n: number): Uint8Array => new Uint8Array(n);
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function setup(launch: LaunchSettings | null, stored: StoredTextFile[] = []) {
  const calls: unknown[][] = [];
  const loaded: string[][] = [];
  let pending = launch;
  let shader: string | null = null;
  const controller = {
    discOpens: 1,
    setVolume: (v: number) => void calls.push(['volume', v]),
    toggleMute: () => void calls.push(['mute']),
    selectAudio: (i: number) => void calls.push(['audio', i]),
    selectSubtitle: (c: SubtitleChoice) => void calls.push(['subtitle', c]),
    loadSubtitleFiles: async (files: readonly File[]) => void loaded.push(files.map((f) => f.name)),
    setSubtitleStart: (i: number, us: number | null) => void calls.push(['start', i, us]),
    shiftSubtitleFile: (i: number, ms: number) => void calls.push(['shift', i, ms]),
    scaleSubtitles: (d: number) => void calls.push(['scale', d]),
  };
  const applier = new LaunchSettingsApplier({
    controller,
    places: {
      takeLaunchSettings: () => {
        const l = pending;
        pending = null;
        return l && { ...l, discKey: KEY };
      },
      storedTextFiles: async (key) => (key === KEY ? stored : []),
      addTextFiles: async () => {},
    },
    selectShader: (name) => {
      shader = name;
      calls.push(['shader', name]);
    },
  });
  let snap: PlayerSnapshot = {
    ...INITIAL_SNAPSHOT, engineState: 'loading', currentPlaylistId: null,
    audioTracks: [
      { index: 1, codec: 'ac3', language: 'eng', channels: 'stereo', playable: true },
      { index: 2, codec: 'ac3', language: 'jpn', channels: 'stereo', playable: true },
    ],
    subtitles: { pg: [{ index: 1, language: 'eng' }, { index: 2, language: 'jpn' }], text: null, selected: 'off', scale: 1 },
  };
  return {
    calls,
    loaded,
    controller,
    show(change: Partial<PlayerSnapshot>) {
      snap = { ...snap, ...change };
      applier.observe(snap, shader);
    },
    get snap() {
      return snap;
    },
  };
}

describe('LaunchSettingsApplier', () => {
  it('waits for the disc to play, then sets volume, mute and the shader once', () => {
    const t = setup({ settings: { ...base, volume: 0.4, muted: true, shaderSet: 'Mode A' }, byLanguage: false });
    t.show({});
    expect(t.calls).toEqual([]);
    t.show({ engineState: 'playing', currentPlaylistId: '00001' });
    t.show({ timeUs: 1 });
    expect(t.calls).toEqual([['volume', 0.4], ['mute'], ['shader', 'Mode A']]);
  });

  it("chooses audio and PG by language for another playlist's settings", () => {
    const t = setup({ settings: { ...base, audioLanguage: 'jpn', pgLanguage: 'jpn', psr1: 5, psr2: 0x80000007 }, byLanguage: true });
    t.show({ engineState: 'playing', currentPlaylistId: '00004' });
    expect(t.calls).toContainEqual(['audio', 2]);
    expect(t.calls).toContainEqual(['subtitle', { kind: 'pg', stream: 2 }]);
  });

  it("leaves audio and PG to the start's registers for a resume", () => {
    const t = setup({ settings: { ...base, psr1: 2, psr2: 0x80000002 }, byLanguage: false });
    t.show({ engineState: 'playing', currentPlaylistId: '00001' });
    expect(t.calls.filter((c) => c[0] === 'audio' || c[0] === 'subtitle')).toEqual([]);
  });

  it('adds the stored text files again with their placements, offsets and scale, and PG back when text was off', async () => {
    const textFiles = [
      { name: 'ep1.ass', size: 10, startUs: 5_000_000, offsetMs: 400 },
      { name: 'other.srt', size: 3, startUs: null, offsetMs: 0 }, // not on this device: skipped silently
    ];
    const t = setup({ settings: { ...base, textFiles, textOn: false, psr2: 0x80000001, textScale: 1.4 }, byLanguage: false }, [
      { name: 'ep1.ass', bytes: bytes(10) }, { name: 'Font.ttf', bytes: bytes(4) },
    ]);
    t.show({ engineState: 'playing', currentPlaylistId: '00001' });
    await settle();
    expect(t.loaded).toEqual([['ep1.ass', 'Font.ttf']]);
    const files: TextFileInfo[] = [{ name: 'ep1.ass', format: 'ass', cues: 3, startUs: 0, offsetMs: 0 }];
    t.show({ subtitles: { ...t.snap.subtitles!, text: { files, missingFonts: [], episodeStarts: [] }, selected: 'text' } });
    expect(t.calls.slice(-4)).toEqual([['start', 0, 5_000_000], ['shift', 0, 400], ['scale', expect.closeTo(0.4, 5)], ['subtitle', { kind: 'pg', stream: 1 }]]);
  });

  it('keeps the engine placement of a carried file, and adds nothing when this device has none of its files', async () => {
    const textFiles = [{ name: 'ep1.srt', size: 0, startUs: 5_000_000, offsetMs: 0 }];
    const t = setup({ settings: { ...base, textFiles, textOn: true }, byLanguage: true }, [{ name: 'ep1.srt', bytes: bytes(2) }]);
    t.show({ engineState: 'playing', currentPlaylistId: '00004' });
    await settle();
    expect(t.loaded).toEqual([['ep1.srt']]);
    t.show({ subtitles: { ...t.snap.subtitles!, text: { files: [{ name: 'ep1.srt', format: 'srt', cues: 1, startUs: 0, offsetMs: 0 }], missingFonts: [], episodeStarts: [] }, selected: 'text' } });
    expect(t.calls.filter((c) => c[0] === 'start')).toEqual([]);

    const u = setup({ settings: { ...base, textFiles }, byLanguage: true }, []);
    u.show({ engineState: 'playing', currentPlaylistId: '00004' });
    await settle();
    expect(u.loaded).toEqual([]);
  });
});

it('matches stored files by name and, when known, size; fonts only with a subtitle file', () => {
  const stored = [{ name: 'a.srt', bytes: bytes(5) }, { name: 'b.srt', bytes: bytes(6) }, { name: 'F.otf', bytes: bytes(1) }];
  expect(filesToAdd([{ name: 'a.srt', size: 5, startUs: null, offsetMs: 0 }, { name: 'b.srt', size: 7, startUs: null, offsetMs: 0 }], stored)).toEqual({
    subtitles: [stored[0]], fonts: [stored[2]],
  });
  expect(filesToAdd([{ name: 'c.srt', size: 0, startUs: null, offsetMs: 0 }], stored)).toEqual({ subtitles: [], fonts: [] });
});
