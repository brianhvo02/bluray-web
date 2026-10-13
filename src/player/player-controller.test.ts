import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '../engine/protocol';
import { INITIAL_SNAPSHOT, PlayerController, reduceEvent, type AudioOutputLike, type WorkerLike } from './player-controller';

class FakeWorker implements WorkerLike {
  readonly posted: unknown[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  postMessage(message: unknown): void {
    this.posted.push(message);
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
}

const summary = { id: '00000', durationUs: 8_000_000, chapterCount: 4, clipIds: ['00001'], playable: true, missingPaths: [] };

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
    worker.onerror?.({ message: 'Failed to fetch module' } as ErrorEvent);
    expect(c.getSnapshot().error).toEqual({ code: 'internal', message: 'The player engine failed to load: Failed to fetch module', paths: [] });
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
