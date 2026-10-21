import { describe, expect, it } from 'vitest';
import type { DiscPlaces, PlaybackPlace } from '../engine/disc/nas-api';
import type { PlaceState, TextFileInfo } from '../engine/protocol';
import { INITIAL_SNAPSHOT, type PlayerSnapshot } from '../player/player-controller';
import { NasHttpError } from './nas/nas-client';
import { PlaceSaver, type PlaceTarget } from './place-saver';
import { placeKey, type PlaceStore, type StoredTextFile } from './place-store';

const S = 1e6;
const KEY = `f.${'A'.repeat(32)}`;

/** The store in memory, with what was put, in order. */
function memoryStore(): PlaceStore & { puts: PlaybackPlace[]; queued: Map<string, PlaybackPlace>; files: Map<string, StoredTextFile[]> } {
  const places = new Map<string, PlaybackPlace>();
  const queued = new Map<string, PlaybackPlace>();
  const files = new Map<string, StoredTextFile[]>();
  const puts: PlaybackPlace[] = [];
  return {
    puts,
    queued,
    files,
    async put(p) {
      puts.push(p);
      places.set(placeKey(p), p);
    },
    async get(discKey): Promise<DiscPlaces> {
      const mine = [...places.values()].filter((p) => p.discKey === discKey);
      return { defaults: mine.at(-1)?.settings ?? null, places: Object.fromEntries(mine.map((p) => [p.playlistId, p])) };
    },
    async outbox() {
      return [...queued.values()];
    },
    async queue(p) {
      queued.set(placeKey(p), p);
    },
    async sent(key, updatedAt) {
      if ((queued.get(key)?.updatedAt ?? Infinity) <= updatedAt) queued.delete(key);
    },
    async putTextFiles(discKey, list) {
      files.set(discKey, [...list]);
    },
    async textFiles(discKey) {
      return files.get(discKey) ?? [];
    },
  };
}

type Answer = 'stored' | 'stale' | Error;

/** The NAS: answers each put with `answer` (stored by default), recording what it was sent. */
function fakeNas(): { putPlace: (p: PlaybackPlace, opts?: { keepalive?: boolean }) => Promise<'stored' | 'stale'>; sent: { place: PlaybackPlace; keepalive: boolean }[]; answer: Answer } {
  const nas = {
    sent: [] as { place: PlaybackPlace; keepalive: boolean }[],
    answer: 'stored' as Answer,
    async putPlace(place: PlaybackPlace, opts: { keepalive?: boolean } = {}) {
      nas.sent.push({ place, keepalive: opts.keepalive === true });
      if (nas.answer instanceof Error) throw nas.answer;
      return nas.answer;
    },
  };
  return nas;
}

const placeState = (title = 1): PlaceState => ({ mode: 'hdmv', title, psrs: Array.from({ length: 128 }, (_, i) => (i === 4 ? title : 0)), gprs: { 7: 42 } });

function setup(opts: { remote?: boolean; target?: Partial<PlaceTarget>; minUs?: number } = {}) {
  let clock = 1_800_000_000_000;
  let opens = 1;
  const timers = new Map<number, { fn: () => void; at: number }>();
  let nextTimer = 0;
  const store = memoryStore();
  const nas = fakeNas();
  let registers = placeState();
  let shader: string | null = null;
  const reads: number[] = [];
  const saver = new PlaceSaver({
    store,
    nas,
    readPlace: async () => {
      reads.push(opens);
      return registers;
    },
    discOpens: () => opens,
    nowMs: () => clock,
    setTimer: (fn, ms) => {
      timers.set(++nextTimer, { fn, at: clock + ms });
      return nextTimer;
    },
    clearTimer: (id) => timers.delete(id as number),
    minDurationUs: opts.minUs ?? 300 * S,
  });
  saver.begin({ discKey: KEY, discId: '0123456789abcdef', remote: opts.remote ?? true, chosen: '00001', mainPlaylistId: null, deviceName: 'iPad', ...opts.target });
  let snap: PlayerSnapshot = { ...INITIAL_SNAPSHOT, playlists: [], currentPlaylistId: '00001', durationUs: 1440 * S, timeUs: 0, engineState: 'playing', selectedAudio: 1 };
  const t = {
    saver,
    store,
    nas,
    reads,
    get snap() {
      return snap;
    },
    setRegisters(p: PlaceState) {
      registers = p;
    },
    setOpens(n: number) {
      opens = n;
    },
    /** Shows the saver a new snapshot (with a new shader set when given). */
    show(change: Partial<PlayerSnapshot>, set?: string | null) {
      snap = { ...snap, ...change };
      if (set !== undefined) shader = set;
      saver.observe(snap, shader);
    },
    /** Moves the clock by `ms`, playback with it while playing, firing timers as they fall due. */
    async play(ms: number) {
      const end = clock + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        const to = due ? due[1].at : end;
        const step = to - clock;
        clock = to;
        if (snap.engineState === 'playing') t.show({ timeUs: snap.timeUs + step * 1000 });
        if (!due) break;
        timers.delete(due[0]);
        due[1].fn();
        await settle();
      }
      await settle();
    },
  };
  t.show({});
  return t;
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('PlaceSaver', () => {
  it('saves every 10 s while playing, and not while paused', async () => {
    const t = setup();
    await t.play(9_999);
    expect(t.store.puts).toHaveLength(0);
    await t.play(1);
    expect(t.store.puts.map((p) => p.timeUs)).toEqual([10 * S]);
    await t.play(10_000);
    expect(t.store.puts.map((p) => p.timeUs)).toEqual([10 * S, 20 * S]);
    t.show({ engineState: 'paused' }); // pause saves at once
    await settle();
    expect(t.store.puts).toHaveLength(3);
    await t.play(60_000);
    expect(t.store.puts).toHaveLength(3);
    const last = t.store.puts[2]!;
    expect(last).toMatchObject({ discKey: KEY, discId: '0123456789abcdef', playlistId: '00001', timeUs: 20 * S, mode: 'hdmv', title: 1, deviceName: 'iPad', gprs: { 7: 42 } });
    expect(t.nas.sent.map((s) => s.place.timeUs)).toEqual([10 * S, 20 * S, 20 * S]);
    expect(t.store.queued.size).toBe(0);
  });

  it('saves at once on a seek, a track change, an offset change and a shader change', async () => {
    const t = setup();
    await t.play(3_000);
    t.show({ timeUs: 600 * S }); // seek
    await settle();
    expect(t.store.puts.map((p) => p.timeUs)).toEqual([600 * S]);
    t.show({ selectedAudio: 2 });
    await settle();
    expect(t.store.puts).toHaveLength(2);
    const file: TextFileInfo = { name: 'ep1.ass', format: 'ass', cues: 10, startUs: 0, offsetMs: 0 };
    t.show({ subtitles: { pg: [], text: { files: [file], missingFonts: [], episodeStarts: [] }, selected: 'text', scale: 1 } });
    await settle();
    t.show({ subtitles: { pg: [], text: { files: [{ ...file, offsetMs: 400 }], missingFonts: [], episodeStarts: [] }, selected: 'text', scale: 1 } });
    await settle();
    expect(t.store.puts).toHaveLength(4);
    expect(t.store.puts[3]!.settings.textFiles).toEqual([{ name: 'ep1.ass', size: 0, startUs: 0, offsetMs: 400 }]);
    t.show({}, 'Anime4K: Mode A (Fast)');
    await settle();
    expect(t.store.puts.at(-1)!.settings.shaderSet).toBe('Anime4K: Mode A (Fast)');
    await t.play(1_000); // playing on is no trigger
    expect(t.store.puts).toHaveLength(5);
  });

  it("keeps an episode's place when a short menu playlist follows it, saving the episode where it stopped", async () => {
    const t = setup({ target: { chosen: null } });
    await t.play(10_000);
    expect(t.store.puts).toHaveLength(1);
    await t.play(5_000);
    // the episode stops at 15 s and the disc's 30 s menu loop plays
    t.setRegisters(placeState(9));
    t.show({ currentPlaylistId: '00099', durationUs: 30 * S, timeUs: 0 });
    await settle();
    expect(t.store.puts.map((p) => [p.playlistId, p.timeUs, p.title])).toEqual([['00001', 10 * S, 1], ['00001', 15 * S, 1]]);
    await t.play(30_000);
    t.show({ engineState: 'paused' });
    await settle();
    expect(t.store.puts.every((p) => p.playlistId === '00001')).toBe(true);
    expect(t.store.puts).toHaveLength(2);
  });

  it('marks a place finished when its playlist ends', async () => {
    const t = setup();
    await t.play(10_000);
    t.show({ engineState: 'ended', timeUs: 1440 * S });
    await settle();
    expect(t.store.puts.at(-1)).toMatchObject({ timeUs: 1440 * S, finished: true });
  });

  it('keeps a place in the outbox while the NAS is unreachable and sends it later', async () => {
    const t = setup();
    t.nas.answer = new Error("Couldn't reach the NAS.");
    await t.play(10_000);
    expect(t.store.puts).toHaveLength(1); // on the device all the same
    expect([...t.store.queued.values()].map((p) => p.timeUs)).toEqual([10 * S]);
    t.nas.answer = 'stored';
    await t.saver.drainOutbox();
    expect(t.store.queued.size).toBe(0);
    expect(t.nas.sent.at(-1)!.place.timeUs).toBe(10 * S);
  });

  it('drops an outbox place the NAS answers stale for, or refuses for good', async () => {
    const t = setup();
    t.nas.answer = 'stale';
    await t.play(10_000);
    expect(t.nas.sent).toHaveLength(1);
    expect(t.store.queued.size).toBe(0);
    t.nas.answer = new NasHttpError(413, null);
    await t.play(10_000);
    expect(t.nas.sent).toHaveLength(2);
    expect(t.store.queued.size).toBe(0);
  });

  it('passes keepalive on a flush for a page being hidden, and keeps a local disc on the device', async () => {
    const t = setup();
    await t.play(3_000);
    await t.saver.flushNow({ keepalive: true });
    expect(t.nas.sent.map((s) => [s.place.timeUs, s.keepalive])).toEqual([[3 * S, true]]);
    const local = setup({ remote: false });
    await local.play(10_000);
    await local.saver.flushNow({ keepalive: true });
    expect(local.store.puts).toHaveLength(2);
    expect(local.nas.sent).toHaveLength(0);
    expect(local.store.queued.size).toBe(0);
  });

  it('saves nothing for a local disc without a fingerprint', async () => {
    const t = setup({ remote: false, target: { discKey: 'd.0123456789abcdef' } });
    await t.play(20_000);
    await t.saver.flushNow({ keepalive: false });
    expect(t.store.puts).toHaveLength(0);
  });

  it("never saves registers read after another disc opened, but keeps a save made just before a close", async () => {
    const t = setup();
    await t.play(3_000);
    void t.saver.flushNow({ keepalive: false }); // the close's save: read before the close
    t.saver.end();
    t.setOpens(2); // closeDisc
    await settle();
    expect(t.reads).toEqual([1]);
    expect(t.store.puts.map((p) => p.timeUs)).toEqual([3 * S]);

    const u = setup();
    await u.play(3_000);
    u.setOpens(2); // another disc opened without this one being ended
    await u.saver.flushNow({ keepalive: false });
    u.show({ engineState: 'paused' });
    await settle();
    expect(u.reads).toEqual([]);
    expect(u.store.puts).toHaveLength(0);
  });

  it("gives text files their sizes, keeps their bytes for this device, and sends at most 64", async () => {
    const t = setup();
    const ass = new File(['[Script Info]'], 'ep1.ass');
    const font = new File([new Uint8Array(8)], 'font.ttf');
    await t.saver.addTextFiles([ass, font]);
    expect(t.store.files.get(KEY)?.map((f) => [f.name, f.bytes.byteLength])).toEqual([['ep1.ass', 13], ['font.ttf', 8]]);
    // fonts alone are added to the set
    await t.saver.addTextFiles([new File([new Uint8Array(4)], 'more.otf')]);
    expect(t.store.files.get(KEY)?.map((f) => f.name)).toEqual(['ep1.ass', 'font.ttf', 'more.otf']);
    const files = Array.from({ length: 70 }, (_, i): TextFileInfo => ({ name: i === 0 ? 'ep1.ass' : `x${i}.srt`, format: 'srt', cues: 1, startUs: null, offsetMs: 0 }));
    t.show({ subtitles: { pg: [], text: { files, missingFonts: [], episodeStarts: [] }, selected: 'text', scale: 1 } });
    await settle();
    const sent = t.nas.sent.at(-1)!.place.settings.textFiles;
    expect(sent).toHaveLength(64);
    expect(sent[0]).toEqual({ name: 'ep1.ass', size: 13, startUs: null, offsetMs: 0 });
  });
});
