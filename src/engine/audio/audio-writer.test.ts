import { describe, expect, it } from 'vitest';
import type { PcmChunk } from '../decode/lpcm';
import { AudioWriter } from './audio-writer';
import { RingWriter, createRing, renderQuantum, ringViews } from './ring';

function chunk(ptsUs: number, frames: number, value: number, sampleRate = 48_000): PcmChunk {
  return { ptsUs, sampleRate, frames, stereo: new Float32Array(frames * 2).fill(value) };
}

function setup(seconds = 1): { writer: AudioWriter; ring: RingWriter; views: ReturnType<typeof ringViews> } {
  const views = ringViews(createRing(48_000, seconds));
  const ring = new RingWriter(views);
  return { writer: new AudioWriter(ring), ring, views };
}

describe('AudioWriter', () => {
  it('places chunks by PTS relative to the start time', () => {
    const { writer, ring, views } = setup();
    writer.start(10_000_000);
    writer.enqueue(chunk(10_000_000, 240, 1));
    writer.enqueue(chunk(10_010_000, 240, 2)); // 5 ms gap → 240 frames of silence
    expect(ring.writtenFrames()).toBe(720);
    expect(views.data[239 * 2]).toBe(1);
    expect(views.data[240 * 2]).toBe(0);
    expect(views.data[480 * 2]).toBe(2);
  });

  it('drops samples before the start time (seek trimming)', () => {
    const { writer, ring, views } = setup();
    writer.start(1_000_000);
    writer.enqueue(chunk(995_000, 480, 7)); // first 240 frames precede the start
    expect(ring.writtenFrames()).toBe(240);
    expect(views.data[0]).toBe(7);
  });

  it('queues chunks while the ring is full and drains when the reader advances', () => {
    const { writer, ring, views } = setup(0.01); // 480 frames
    writer.start(0);
    writer.enqueue(chunk(0, 480, 1));
    writer.enqueue(chunk(10_000, 240, 2));
    expect(writer.queuedChunks).toBe(1);
    ring.setPlaying(true);
    renderQuantum(views, new Float32Array(128), new Float32Array(128));
    renderQuantum(views, new Float32Array(128), new Float32Array(128));
    writer.drain();
    expect(writer.queuedChunks).toBe(0);
    expect(ring.writtenFrames()).toBe(720);
  });

  it('maps media time to frames from the read head at start()', () => {
    const { writer, ring, views } = setup();
    ring.setPlaying(true);
    renderQuantum(views, new Float32Array(128), new Float32Array(128));
    writer.start(2_000_000);
    expect(writer.frameAt(2_000_000)).toBe(128);
    expect(writer.frameAt(2_001_000)).toBe(176);
  });

  it('rejects chunks at the wrong sample rate', () => {
    const { writer } = setup();
    writer.start(0);
    expect(() => writer.enqueue(chunk(0, 10, 1, 96_000))).toThrow(/sample rate/);
  });
});
