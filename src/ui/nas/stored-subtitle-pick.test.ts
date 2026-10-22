import { describe, expect, it } from 'vitest';
import type { StoredSubtitle } from '../../engine/disc/nas-api';
import type { SubtitleChoice, TextFileInfo } from '../../engine/protocol';
import { INITIAL_SNAPSHOT, type PlayerSnapshot } from '../../player/player-controller';
import { pickStoredSubtitle, replacesTextSet, STORED_PICK_FAILED } from './stored-subtitle-pick';

const KEY = `f.${'B'.repeat(32)}`;
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const episodeSub: StoredSubtitle = {
  id: 'sub-1', name: 'Fansub', language: 'en', offsetMs: 400, fileName: 'ep1.ass', fileSize: 120, fonts: [{ name: 'Made Up Sans.ttf', size: 50 }],
  attachment: { kind: 'episode', discKey: KEY, playlistId: '00001', titleId: 'anilist:1', seasonId: 's1', episode: 1 }, uploaderPersonId: 'p1', uploadedAt: 1,
};
const chapterSub: StoredSubtitle = { ...episodeSub, id: 'sub-2', offsetMs: 0, attachment: { kind: 'chapter', discKey: KEY, playlistId: '00001', chapter: 2 } };

const file = (name: string, offsetMs = 0, startUs: number | null = null): TextFileInfo => ({ name, format: name.endsWith('.srt') ? 'srt' : 'ass', cues: 3, startUs, offsetMs });

function setup(opts: { fetchFails?: boolean; loaded?: readonly TextFileInfo[] } = {}) {
  const calls: unknown[][] = [];
  const listeners = new Set<() => void>();
  let snap: PlayerSnapshot = {
    ...INITIAL_SNAPSHOT, engineState: 'playing', currentPlaylistId: '00001',
    chapters: [{ index: 0, startUs: 0 }, { index: 1, startUs: 60_000_000 }, { index: 2, startUs: 120_000_000 }],
    subtitles: { pg: [], text: opts.loaded ? { files: opts.loaded, missingFonts: [], episodeStarts: [] } : null, selected: opts.loaded ? 'text' : 'off', scale: 1 },
  };
  const show = (change: Partial<PlayerSnapshot>): void => {
    snap = { ...snap, ...change };
    for (const l of [...listeners]) l();
  };
  /** The engine's answer to a load: the text set is now `files`. */
  const engineLists = (...files: TextFileInfo[]): void => show({ subtitles: { ...snap.subtitles!, text: { files, missingFonts: [], episodeStarts: [] } } });
  const controller = {
    discOpens: 1,
    loadSubtitleFiles: async (files: readonly File[]) => void calls.push(['load', files.map((f) => f.name)]),
    setSubtitleStart: (i: number, us: number | null) => void calls.push(['start', i, us]),
    shiftSubtitleFile: (i: number, ms: number) => {
      calls.push(['shift', i, ms]);
      // as the controller does: the snapshot shows the new offset at once
      const text = snap.subtitles!.text!;
      show({ subtitles: { ...snap.subtitles!, text: { ...text, files: text.files.map((f, j) => (j === i ? { ...f, offsetMs: f.offsetMs + ms } : f)) } } });
    },
    selectSubtitle: (c: SubtitleChoice) => void calls.push(['select', c]),
    showNotice: (code: string, message: string) => void calls.push(['notice', code, message]),
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
  const nas = {
    subtitleFiles: async (s: StoredSubtitle) => {
      calls.push(['fetch', s.id]);
      if (opts.fetchFails) throw new Error('offline');
      return [new File(['[Script Info]'], s.fileName), ...s.fonts.map((f) => new File(['font'], f.name))];
    },
  };
  const places = { noteStoredSubtitle: (name: string, id: string, size: number) => void calls.push(['note', name, id, size]) };
  const pick = (s: StoredSubtitle) => pickStoredSubtitle({ nas, controller, places, snapshot: () => snap, log: () => {} }, s);
  return { calls, controller, engineLists, pick, show };
}

describe('pickStoredSubtitle', () => {
  it('loads the file with its fonts, then places an episode subtitle at 0 with its default offset, selects text and notes the id', async () => {
    const t = setup();
    const done = t.pick(episodeSub);
    await settle();
    expect(t.calls).toEqual([['fetch', 'sub-1'], ['load', ['ep1.ass', 'Made Up Sans.ttf']]]);
    t.engineLists(file('ep1.ass'));
    expect(await done).toBe(true);
    expect(t.calls.slice(2)).toEqual([['start', 0, 0], ['shift', 0, 400], ['select', { kind: 'text' }], ['note', 'ep1.ass', 'sub-1', 120]]);
  });

  it("places a chapter's subtitle at that chapter's start", async () => {
    const t = setup();
    const done = t.pick(chapterSub);
    await settle();
    t.engineLists(file('ep1.ass'));
    expect(await done).toBe(true);
    expect(t.calls).toContainEqual(['start', 0, 120_000_000]);
    // no default offset: nothing to shift
    expect(t.calls.filter((c) => c[0] === 'shift')).toEqual([]);
  });

  it("leaves a chapter's subtitle unplaced when the playlist has no such chapter", async () => {
    const t = setup();
    const done = t.pick({ ...chapterSub, attachment: { ...chapterSub.attachment, chapter: 9 } as StoredSubtitle['attachment'] });
    await settle();
    t.engineLists(file('ep1.ass'));
    expect(await done).toBe(true);
    expect(t.calls.filter((c) => c[0] === 'start')).toEqual([]);
  });

  it('applies the default offset once, against the offset the engine reports', async () => {
    const t = setup();
    const done = t.pick(episodeSub);
    await settle();
    t.engineLists(file('ep1.ass', 100));
    expect(await done).toBe(true);
    t.engineLists(file('ep1.ass', 500));
    t.engineLists(file('ep1.ass', 500));
    expect(t.calls.filter((c) => c[0] === 'shift')).toEqual([['shift', 0, 300]]);
  });

  it('changes nothing and shows a notice when the fetch fails', async () => {
    const t = setup({ fetchFails: true, loaded: [file('mine.srt', 200, 0)] });
    expect(await t.pick(episodeSub)).toBe(false);
    expect(t.calls).toEqual([['fetch', 'sub-1'], ['notice', 'stored-subtitle', STORED_PICK_FAILED]]);
    expect(STORED_PICK_FAILED).toBe("Couldn't load the subtitles from the NAS.");
  });

  it('replaces local files already loaded, waiting for the new set rather than the old one, and notes the id', async () => {
    const t = setup({ loaded: [file('ep1.ass', 900, 0), file('other.srt')] });
    const done = t.pick(episodeSub);
    await settle();
    expect(t.calls).toContainEqual(['load', ['ep1.ass', 'Made Up Sans.ttf']]);
    // the old set still lists a file of that name: not the engine's answer yet
    expect(t.calls.filter((c) => c[0] === 'shift' || c[0] === 'note')).toEqual([]);
    t.engineLists(file('ep1.ass'));
    expect(await done).toBe(true);
    expect(t.calls).toContainEqual(['shift', 0, 400]);
    expect(t.calls).toContainEqual(['note', 'ep1.ass', 'sub-1', 120]);
  });

  it('gives up when another disc opens while the files are fetched', async () => {
    const t = setup();
    const done = t.pick(episodeSub);
    t.controller.discOpens = 2;
    expect(await done).toBe(false);
    expect(t.calls).toEqual([['fetch', 'sub-1']]);
  });
});

describe('replacesTextSet', () => {
  it('is true for a pick with subtitle files (or unrecognised ones), false for fonts alone', () => {
    expect(replacesTextSet([new File([''], 'a.srt'), new File([''], 'f.ttf')])).toBe(true);
    expect(replacesTextSet([new File([''], 'subtitles.txt')])).toBe(true);
    expect(replacesTextSet([new File([''], 'f.ttf')])).toBe(false);
    expect(replacesTextSet([])).toBe(false);
  });
});
