import { describe, expect, it } from 'vitest';
import type { AudioTrack, EngineEvent, Telemetry } from '../engine/protocol';
import { INITIAL_SNAPSHOT, PlayerController, reduceEvent, type AudioOutputLike, type WorkerLike } from './player-controller';

class FakeWorker implements WorkerLike {
  readonly posted: unknown[] = [];
  readonly transfers: unknown[][] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  postMessage(message: unknown, transfer: unknown[] = []): void {
    this.posted.push(message);
    this.transfers.push(transfer);
  }
  emit(event: EngineEvent): void {
    this.onmessage?.({ data: event } as MessageEvent);
  }
}

class FakeAudio implements AudioOutputLike {
  volume = 1;
  muted = false;
  starts = 0;
  readonly ring = new SharedArrayBuffer(8);
  fail = false;
  ensureStarted(): Promise<SharedArrayBuffer> {
    this.starts++;
    return this.fail ? Promise.reject(new Error('no audio device')) : Promise.resolve(this.ring);
  }
  setVolume(v: number): void {
    this.volume = v;
  }
  setMuted(m: boolean): void {
    this.muted = m;
  }
  readonly loaded: number[] = [];
  readonly played: number[] = [];
  loadEffects(clips: ReadonlyArray<{ channels: 1 | 2; samples: Int16Array }>): void {
    this.loaded.push(clips.length);
  }
  playEffect(id: number): void {
    this.played.push(id);
  }
}

const summary = { id: '00000', durationUs: 8_000_000, chapterCount: 4, clipIds: ['00001'], playable: true, missingPaths: [], looped: false };

describe('reduceEvent', () => {
  it('tracks titles, chapters, state and time', () => {
    let s = reduceEvent(INITIAL_SNAPSHOT, { type: 'titles', playlists: [summary], usesBdj: false, warnings: [] });
    s = reduceEvent(s, { type: 'chapters', playlistId: '00000', durationUs: 8_000_000, chapters: [{ index: 0, startUs: 0 }] });
    s = reduceEvent(s, { type: 'state', state: 'playing' });
    s = reduceEvent(s, { type: 'time', timeUs: 1_500_000 });
    expect(s).toMatchObject({ playlists: [summary], currentPlaylistId: '00000', durationUs: 8_000_000, engineState: 'playing', timeUs: 1_500_000 });
  });

  it('dedupes notices by code and records unsupported streams and errors', () => {
    let s = reduceEvent(INITIAL_SNAPSHOT, { type: 'notice', code: 'audio-disabled', message: 'a' });
    s = reduceEvent(s, { type: 'notice', code: 'audio-disabled', message: 'b' });
    s = reduceEvent(s, { type: 'unsupported', kind: 'audio', codec: 'DTS', message: 'no DTS' });
    s = reduceEvent(s, { type: 'error', code: 'not-bdmv', message: 'nope', paths: ['BDMV/INDEX.BDMV'] });
    expect(s.notices).toEqual([
      { code: 'audio-disabled', message: 'b' },
      { code: 'unsupported-audio', message: 'no DTS' },
    ]);
    expect(s.error).toEqual({ code: 'not-bdmv', message: 'nope', paths: ['BDMV/INDEX.BDMV'] });
  });
});

describe('playlist lifecycle', () => {
  it('clears the playlist when the engine reports it gone', () => {
    let s = reduceEvent(INITIAL_SNAPSHOT, { type: 'chapters', playlistId: '00000', durationUs: 8_000_000, chapters: [{ index: 0, startUs: 0 }] });
    s = reduceEvent(s, { type: 'time', timeUs: 3_000_000 });
    s = reduceEvent(s, { type: 'playlistCleared' });
    expect(s).toMatchObject({ currentPlaylistId: null, durationUs: 0, chapters: [], timeUs: 0 });
  });

  it('closes the disc in the engine, not just the UI', () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    worker.emit({ type: 'titles', playlists: [summary], usesBdj: false, warnings: [] });
    c.closeDisc();
    expect(worker.posted).toEqual([{ type: 'close' }]);
    expect(c.getSnapshot().playlists).toEqual([]);
  });
});

describe('notices across playlists', () => {
  // The engine emits a playlist's own notices *before* its `chapters` event (engine/player.ts playPlaylist).
  function startPlaylist(worker: FakeWorker, c: PlayerController, id: string, notices: EngineEvent[]): void {
    c.playPlaylist(id);
    for (const e of notices) worker.emit(e);
    worker.emit({ type: 'chapters', playlistId: id, durationUs: 1, chapters: [] });
  }

  it("keeps the new playlist's own unsupported-audio and audio-disabled notices", () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    startPlaylist(worker, c, '00000', [
      { type: 'unsupported', kind: 'audio', codec: 'DTS', message: 'no DTS' },
      { type: 'notice', code: 'audio-disabled', message: 'no output' },
    ]);
    expect(c.getSnapshot().notices.map((n) => n.code)).toEqual(['unsupported-audio', 'audio-disabled']);
  });

  it("drops the previous playlist's playlist-specific notices when another is picked, keeping disc and device notices", async () => {
    const worker = new FakeWorker();
    const audio = new FakeAudio();
    audio.fail = true;
    const c = new PlayerController(worker, audio);
    worker.emit({ type: 'notice', code: 'bdj', message: 'bd-j' });
    startPlaylist(worker, c, '00000', [
      { type: 'unsupported', kind: 'audio', codec: 'DTS', message: 'no DTS' },
      { type: 'notice', code: 'decoder-recovered', message: 'recovered' },
    ]);
    await new Promise((r) => setTimeout(r, 0)); // audio start rejects → 'audio-output' notice
    startPlaylist(worker, c, '00001', []);
    await new Promise((r) => setTimeout(r, 0));
    expect(c.getSnapshot().notices.map((n) => n.code).sort()).toEqual(['audio-output', 'bdj']);
  });
});

describe('PlayerController', () => {
  it('surfaces worker load and message errors as an internal error', () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    worker.emit({ type: 'state', state: 'buffering' });
    worker.onerror?.({ message: 'Failed to fetch module' } as ErrorEvent);
    expect(c.getSnapshot().error).toEqual({ code: 'internal', message: 'The player engine stopped unexpectedly: Failed to fetch module', paths: [] });
    expect(c.getSnapshot().engineState).toBe('error'); // no spinner left behind
    worker.onmessageerror?.({} as MessageEvent);
    expect(c.getSnapshot().error?.code).toBe('internal');
  });

  it('starts audio and attaches the ring once, then opens the disc', async () => {
    const worker = new FakeWorker();
    const audio = new FakeAudio();
    const c = new PlayerController(worker, audio);
    const file = new File(['x'], 'index.bdmv');
    c.open([['Disc/BDMV/index.bdmv', file]]);
    c.play();
    await Promise.resolve();
    await Promise.resolve();
    expect(worker.posted).toEqual([
      { type: 'open', entries: [['Disc/BDMV/index.bdmv', file]] },
      { type: 'play' },
      { type: 'attachAudio', ring: audio.ring },
    ]);
    expect(audio.starts).toBe(2);
  });

  it('notifies subscribers with new snapshots from worker events', () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    let calls = 0;
    const unsubscribe = c.subscribe(() => calls++);
    const before = c.getSnapshot();
    worker.emit({ type: 'state', state: 'buffering' });
    expect(calls).toBe(1);
    expect(c.getSnapshot()).not.toBe(before);
    expect(c.getSnapshot().engineState).toBe('buffering');
    unsubscribe();
    worker.emit({ type: 'state', state: 'playing' });
    expect(calls).toBe(1);
  });

  it('toggles play/pause based on engine state and clamps seeks and volume', () => {
    const worker = new FakeWorker();
    const audio = new FakeAudio();
    const c = new PlayerController(worker, audio);
    worker.emit({ type: 'chapters', playlistId: '00000', durationUs: 8_000_000, chapters: [] });
    worker.emit({ type: 'state', state: 'playing' });
    worker.emit({ type: 'time', timeUs: 7_000_000 });
    worker.posted.length = 0;
    c.togglePlay();
    c.seekBy(10_000_000);
    c.seek(-5);
    c.setVolume(1.7);
    c.toggleMute();
    expect(worker.posted).toEqual([{ type: 'pause' }, { type: 'seek', timeUs: 8_000_000 }, { type: 'seek', timeUs: 0 }]);
    expect(audio.volume).toBe(1);
    expect(audio.muted).toBe(true);
    expect(c.getSnapshot()).toMatchObject({ volume: 1, muted: true });
  });

  it('adjustVolume unmutes, so the change is audible', () => {
    const audio = new FakeAudio();
    const c = new PlayerController(new FakeWorker(), audio);
    c.setVolume(0.5);
    c.toggleMute();
    c.adjustVolume(0.1);
    expect(audio.muted).toBe(false);
    expect(audio.volume).toBeCloseTo(0.6);
    expect(c.getSnapshot()).toMatchObject({ muted: false });
    c.adjustVolume(-5);
    expect(c.getSnapshot().volume).toBe(0);
  });

  it('adds a notice when audio cannot start', async () => {
    const audio = new FakeAudio();
    audio.fail = true;
    const c = new PlayerController(new FakeWorker(), audio);
    c.startAudio();
    await new Promise((r) => setTimeout(r, 0));
    expect(c.getSnapshot().notices).toEqual([{ code: 'audio-output', message: 'Audio output could not start: no audio device' }]);
  });

  it('attaches the ring after a retry when the first audio start failed', async () => {
    const worker = new FakeWorker();
    const audio = new FakeAudio();
    audio.fail = true;
    const c = new PlayerController(worker, audio);
    c.startAudio();
    await new Promise((r) => setTimeout(r, 0));
    expect(c.getSnapshot().notices).toHaveLength(1);

    audio.fail = false;
    c.startAudio();
    await new Promise((r) => setTimeout(r, 0));
    expect(worker.posted.filter((m) => (m as { type: string }).type === 'attachAudio')).toEqual([{ type: 'attachAudio', ring: audio.ring }]);
  });
});

describe('audio tracks', () => {
  const tracks: AudioTrack[] = [
    { index: 1, codec: 'LPCM', language: 'jpn', channels: 'stereo', playable: true },
    { index: 2, codec: 'DTS-HD (secondary)', language: 'eng', channels: 'stereo', playable: false },
    { index: 3, codec: 'Dolby Digital (AC-3)', language: 'eng', channels: 'multichannel', playable: true },
  ];

  it('stores tracks and clears them with the playlist', () => {
    let s = reduceEvent(INITIAL_SNAPSHOT, { type: 'tracks', audio: tracks, selectedAudio: 1 });
    expect(s).toMatchObject({ audioTracks: tracks, selectedAudio: 1 });
    s = reduceEvent(s, { type: 'playlistCleared' });
    expect(s).toMatchObject({ audioTracks: [], selectedAudio: null });
  });

  it('selects a playable track with a confirmation notice and ignores the rest', () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    worker.emit({ type: 'tracks', audio: tracks, selectedAudio: 1 });
    worker.posted.length = 0;
    c.selectAudio(2);
    c.selectAudio(1);
    c.selectAudio(3);
    expect(worker.posted).toEqual([{ type: 'selectAudio', index: 3 }]);
    expect(c.getSnapshot().notices).toContainEqual({ code: 'audio-track', message: 'Audio: 3. English · Dolby Digital (AC-3) (multichannel)' });
  });

  it('cycles through playable tracks and wraps around', () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    worker.emit({ type: 'tracks', audio: tracks, selectedAudio: 3 });
    worker.posted.length = 0;
    c.cycleAudio();
    expect(worker.posted).toEqual([{ type: 'selectAudio', index: 1 }]);
  });

  it('shows a selection at once, so quick A presses move on before the engine confirms', () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    worker.emit({ type: 'tracks', audio: tracks, selectedAudio: 1 });
    worker.posted.length = 0;
    c.cycleAudio();
    expect(c.getSnapshot().selectedAudio).toBe(3);
    c.cycleAudio();
    expect(worker.posted).toEqual([
      { type: 'selectAudio', index: 3 },
      { type: 'selectAudio', index: 1 },
    ]);
    worker.emit({ type: 'tracks', audio: tracks, selectedAudio: 3 }); // the engine's word wins
    expect(c.getSnapshot().selectedAudio).toBe(3);
  });
});

describe('menus', () => {
  const make = () => {
    const worker = new FakeWorker();
    const controller = new PlayerController(worker, new FakeAudio());
    return { worker, controller };
  };

  it('tracks whether a menu is shown and whether a pop-up is available', () => {
    let s = reduceEvent(INITIAL_SNAPSHOT, { type: 'menuActive', active: true, popupAvailable: true });
    expect(s).toMatchObject({ menuActive: true, popupAvailable: true });
    s = reduceEvent(s, { type: 'menuActive', active: false, popupAvailable: false });
    expect(s).toMatchObject({ menuActive: false, popupAvailable: false });
  });

  it('tracks the button under the pointer and forgets it when the menu closes', () => {
    let s = reduceEvent({ ...INITIAL_SNAPSHOT, menuActive: true }, { type: 'pointerTarget', button: 3 });
    expect(s.pointerButton).toBe(3);
    s = reduceEvent(s, { type: 'menuActive', active: false, popupAvailable: false });
    expect(s.pointerButton).toBeNull();
  });

  it('posts menu keys and pointer moves and clicks', () => {
    const { worker, controller } = make();
    controller.menuKey('ok');
    controller.pointer('move', 10, 20);
    controller.pointer('click', 30, 40);
    expect(worker.posted).toEqual([
      { type: 'menuKey', key: 'ok' },
      { type: 'pointer', kind: 'move', x: 10, y: 20 },
      { type: 'pointer', kind: 'click', x: 30, y: 40 },
    ]);
  });
});

describe('UO masks', () => {
  it('exposes the masked operations', () => {
    const worker = new FakeWorker();
    const controller = new PlayerController(worker, new FakeAudio());
    expect(controller.isMasked('timeSearch')).toBe(false);
    worker.emit({ type: 'uoMask', masked: ['timeSearch'] });
    expect(controller.getSnapshot().uoMask).toEqual(['timeSearch']);
    expect(controller.isMasked('timeSearch')).toBe(true);
    expect(controller.isMasked('pauseOn')).toBe(false);
  });

  it('refuses a masked key locally with the same notice, without posting', () => {
    const worker = new FakeWorker();
    const controller = new PlayerController(worker, new FakeAudio());
    worker.emit({ type: 'uoMask', masked: ['timeSearch'] });
    expect(controller.allow('timeSearch')).toBe(false);
    expect(controller.getSnapshot().notices).toContainEqual({ code: 'uo-masked', message: "The disc doesn't allow this here." });
    expect(controller.allow('pauseOn')).toBe(true);
  });
});

describe('titles and the top menu', () => {
  it('keeps the index titles and whether there is a top menu', () => {
    const s = reduceEvent(INITIAL_SNAPSHOT, { type: 'indexTitles', titles: [{ number: 1, kind: 'hdmv' }, { number: 2, kind: 'bdj' }], hasTopMenu: true });
    expect(s.indexTitles).toEqual({ titles: [{ number: 1, kind: 'hdmv' }, { number: 2, kind: 'bdj' }], hasTopMenu: true });
    expect(reduceEvent(s, { type: 'titles', playlists: [], usesBdj: false, warnings: [] }).indexTitles).toBeNull();
  });

  it('posts playTitle and menuCall', () => {
    const worker = new FakeWorker();
    const controller = new PlayerController(worker, new FakeAudio());
    controller.playTitle(1);
    controller.menuCall();
    expect(worker.posted).toEqual([{ type: 'playTitle', title: 1 }, { type: 'menuCall' }]);
  });
});

describe('menu sounds', () => {
  it('loads the disc sounds into the audio output and plays them by id', () => {
    const worker = new FakeWorker();
    const audio = new FakeAudio();
    new PlayerController(worker, audio);
    worker.emit({ type: 'soundEffects', clips: [{ channels: 1, samples: new Int16Array(4) }, { channels: 2, samples: new Int16Array(8) }] });
    worker.emit({ type: 'soundEffect', id: 1 });
    expect(audio.loaded).toEqual([2]);
    expect(audio.played).toEqual([1]);
  });
});

describe('subtitles', () => {
  const subs = (over: Partial<Extract<EngineEvent, { type: 'subtitles' }>> = {}): EngineEvent => ({
    type: 'subtitles', pg: [{ index: 1, language: 'eng' }, { index: 2, language: 'jpn' }], text: null, selected: 'off', scale: 1, ...over,
  });
  const oneFile = { files: [{ name: 'a.srt', format: 'srt' as const, cues: 3, startUs: 0, offsetMs: 0 }], missingFonts: [], episodeStarts: [0] };
  const posted = (w: FakeWorker) => w.posted as Array<{ type: string } & Record<string, unknown>>;

  it('puts the subtitles state and the encoding prompt in the snapshot; a new disc clears them', () => {
    let s = reduceEvent(INITIAL_SNAPSHOT, subs({ selected: { pg: 2 }, text: oneFile }));
    s = reduceEvent(s, { type: 'subtitleEncodingNeeded', names: ['a.srt', 'b.ass'] });
    expect(s.subtitles).toEqual({ pg: [{ index: 1, language: 'eng' }, { index: 2, language: 'jpn' }], text: oneFile, selected: { pg: 2 }, scale: 1 });
    expect(s.encodingPrompt).toEqual({ names: ['a.srt', 'b.ass'] });
    s = reduceEvent(s, { type: 'titles', playlists: [summary], usesBdj: false, warnings: [] });
    expect(s.subtitles).toBeNull();
    expect(s.encodingPrompt).toBeNull();
  });

  it('selects, shifts by absolute offsets with a notice, and scales in steps', () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    worker.emit(subs({ text: oneFile, selected: 'text' }));
    c.selectSubtitle({ kind: 'pg', stream: 2 });
    c.shiftSubtitles(100);
    c.shiftSubtitles(100);
    c.scaleSubtitles(0.1);
    c.scaleSubtitles(5);
    expect(posted(worker)).toEqual([
      { type: 'selectSubtitle', choice: { kind: 'pg', stream: 2 } },
      { type: 'setSubtitleOffset', file: 0, ms: 100 },
      { type: 'setSubtitleOffset', file: 0, ms: 200 },
      { type: 'setSubtitleScale', scale: 1.1 },
      { type: 'setSubtitleScale', scale: 2 },
    ]);
    expect(c.getSnapshot().notices).toContainEqual({ code: 'subtitle-offset', message: 'Subtitles +0.2 s' });
    c.shiftSubtitles(-500);
    expect(c.getSnapshot().notices).toContainEqual({ code: 'subtitle-offset', message: 'Subtitles −0.3 s' });
  });

  it('cycles Off → each PG track → the file → Off', () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    worker.emit(subs({ text: oneFile }));
    for (let i = 0; i < 4; i++) c.cycleSubtitles();
    expect(posted(worker).map((m) => m.choice)).toEqual([{ kind: 'pg', stream: 1 }, { kind: 'pg', stream: 2 }, { kind: 'text' }, { kind: 'off' }]);
  });

  it('refuses a masked subtitle change with the notice and sends nothing', () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    worker.emit(subs({ selected: { pg: 1 } }));
    worker.emit({ type: 'uoMask', masked: ['pgChange'] });
    c.selectSubtitle({ kind: 'pg', stream: 2 });
    expect(worker.posted).toEqual([]);
    expect(c.getSnapshot().notices.map((n) => n.code)).toEqual(['uo-masked']);
    c.selectSubtitle({ kind: 'off' }); // only the display flag: pgEnableDisable is not masked
    expect(posted(worker)).toEqual([{ type: 'selectSubtitle', choice: { kind: 'off' } }]);
  });

  it('refuses a file far too large to be subtitles with a notice, without reading it', async () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    let read = false;
    const huge = { name: 'movie.mkv', size: 4 * 1024 ** 3, arrayBuffer: async () => { read = true; return new ArrayBuffer(0); } } as unknown as File;
    await c.loadSubtitleFile(huge);
    expect(read).toBe(false);
    expect(worker.posted).toEqual([]);
    expect(c.getSnapshot().notices).toContainEqual({ code: 'subtitle-file', message: 'This file is too large to be a subtitle file' });
  });

  it('sends a loaded file\'s bytes, and sends them again with the encoding the user picks', async () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    const file = new File([Uint8Array.of(0x63, 0x61, 0x66, 0xe9)], 'latin.srt');
    await c.loadSubtitleFile(file);
    const first = posted(worker)[0]!;
    const sent = first.files as Array<{ name: string; bytes: ArrayBuffer }>;
    expect(first.type).toBe('addTextSubtitles');
    expect(sent[0]!.name).toBe('latin.srt');
    expect([...new Uint8Array(sent[0]!.bytes)]).toEqual([0x63, 0x61, 0x66, 0xe9]);
    expect(first.encoding).toBeUndefined();
    worker.emit({ type: 'subtitleEncodingNeeded', names: ['latin.srt'] });
    await c.answerEncoding('windows-1252');
    expect(c.getSnapshot().encodingPrompt).toBeNull();
    expect(posted(worker)[1]).toMatchObject({ type: 'addTextSubtitles', encoding: 'windows-1252' });
    worker.emit({ type: 'subtitleEncodingNeeded', names: ['latin.srt'] });
    await c.answerEncoding(null);
    expect(c.getSnapshot().encodingPrompt).toBeNull();
    expect(worker.posted).toHaveLength(2);
    c.removeSubtitleFile();
    expect(posted(worker)[2]).toEqual({ type: 'removeTextSubtitle' });
  });

  describe('subtitle sets', () => {
    const file = (name: string, size = 3) => ({ name, size, arrayBuffer: async () => new ArrayBuffer(size) }) as unknown as File;
    const twoFiles = { files: [{ name: 'ep1.ass', format: 'ass' as const, cues: 3, startUs: 0, offsetMs: 0 }, { name: 'ep2.ass', format: 'ass' as const, cues: 3, startUs: 1_000_000, offsetMs: 0 }], missingFonts: [], episodeStarts: [0, 1_000_000] };

    it('sends the subtitle files and fonts of a pick in one load, transferring every buffer', async () => {
      const worker = new FakeWorker();
      const c = new PlayerController(worker, new FakeAudio());
      await c.loadSubtitleFiles([file('a.ass'), file('b.srt'), file('x.ttf'), file('y.otf')]);
      const sent = posted(worker)[0]!;
      expect(sent.type).toBe('addTextSubtitles');
      expect((sent.files as { name: string }[]).map((f) => f.name)).toEqual(['a.ass', 'b.srt']);
      expect((sent.fonts as { name: string }[]).map((f) => f.name)).toEqual(['x.ttf', 'y.otf']);
      expect(worker.transfers.at(-1)).toHaveLength(4);
    });

    it('skips fonts over the size limit and subtitle files past 64, with notices', async () => {
      const worker = new FakeWorker();
      const c = new PlayerController(worker, new FakeAudio());
      const many = Array.from({ length: 65 }, (_, i) => file(`ep${i}.srt`));
      await c.loadSubtitleFiles([...many, file('huge.ttf', 70 * 1024 * 1024), file('ok.ttf')]);
      const sent = posted(worker)[0]!;
      expect((sent.files as unknown[]).length).toBe(64);
      expect((sent.fonts as { name: string }[]).map((f) => f.name)).toEqual(['ok.ttf']);
      expect(c.getSnapshot().notices).toContainEqual({ code: 'subtitle-fonts', message: 'Fonts over the size limit were skipped: huge.ttf' });
      expect(c.getSnapshot().notices).toContainEqual({ code: 'subtitle-file', message: 'Only the first 64 subtitle files were loaded' });
    });

    it('sends a pick of fonts alone as more fonts for an ASS set', async () => {
      const worker = new FakeWorker();
      const c = new PlayerController(worker, new FakeAudio());
      worker.emit(subs({ text: twoFiles, selected: 'text' }));
      await c.loadSubtitleFiles([file('x.ttf')]);
      expect(posted(worker)[0]).toMatchObject({ type: 'addSubtitleFonts' });
    });

    it('resends the whole load with the encoding the user picks', async () => {
      const worker = new FakeWorker();
      const c = new PlayerController(worker, new FakeAudio());
      await c.loadSubtitleFiles([file('a.srt'), file('x.ttf')]);
      worker.emit({ type: 'subtitleEncodingNeeded', names: ['a.srt'] });
      await c.answerEncoding('windows-1252');
      expect(posted(worker)[1]).toMatchObject({ type: 'addTextSubtitles', encoding: 'windows-1252' });
      expect((posted(worker)[1]!.fonts as unknown[]).length).toBe(1);
    });

    it('places a file and shifts the one showing now', () => {
      const worker = new FakeWorker();
      const c = new PlayerController(worker, new FakeAudio());
      worker.emit(subs({ text: twoFiles, selected: 'text' }));
      c.setSubtitleStart(1, 2_000_000);
      c.shiftSubtitles(100); // nothing showing: no telemetry yet, two files
      worker.emit({ type: 'telemetry', telemetry: { textFile: 1 } as unknown as Telemetry });
      c.shiftSubtitles(100);
      expect(posted(worker)).toEqual([{ type: 'setSubtitleStart', file: 1, startUs: 2_000_000 }, { type: 'setSubtitleOffset', file: 1, ms: 100 }]);
    });
  });
});
