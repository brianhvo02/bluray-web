import { describe, expect, it } from 'vitest';
import { VideoPresenter, type PresentableFrame } from './video-presenter';

interface TestFrame extends PresentableFrame {
  closed: boolean;
}

function frame(timestamp: number): TestFrame {
  return { timestamp, closed: false, close() { this.closed = true; } };
}

describe('VideoPresenter', () => {
  it('shows the newest due frame and closes skipped ones', () => {
    const p = new VideoPresenter<TestFrame>();
    const [a, b, c] = [frame(0), frame(40_000), frame(80_000)];
    p.push(a);
    p.push(b);
    p.push(c);
    expect(p.select(50_000)).toBe(b);
    expect(a.closed).toBe(true);
    expect(p.dropped).toBe(1);
    expect(p.current).toBe(b);
    expect(p.size).toBe(1);
    expect(p.select(60_000)).toBeNull();
    expect(p.select(80_000)).toBe(c);
    expect(b.closed).toBe(true);
    expect(p.presented).toBe(2);
  });

  it('previews the first frame after clear even if it is not due yet, then holds', () => {
    const p = new VideoPresenter<TestFrame>();
    const [a, b] = [frame(1_000_000), frame(1_040_000)];
    p.push(a);
    p.push(b);
    expect(p.select(900_000)).toBe(a);
    expect(p.select(950_000)).toBeNull();
    expect(p.current).toBe(a);
  });

  it('keeps frames sorted when pushed out of order', () => {
    const p = new VideoPresenter<TestFrame>();
    p.push(frame(80_000));
    p.push(frame(40_000));
    expect(p.select(40_000)?.timestamp).toBe(40_000);
  });

  it('dropLate closes all but the newest due frame', () => {
    const p = new VideoPresenter<TestFrame>();
    const frames = [frame(0), frame(40_000), frame(80_000), frame(120_000)];
    for (const f of frames) p.push(f);
    p.dropLate(90_000);
    expect(frames.map((f) => f.closed)).toEqual([true, true, false, false]);
    expect(p.size).toBe(2);
    expect(p.dropped).toBe(2);
  });

  it('clear closes queued and current frames', () => {
    const p = new VideoPresenter<TestFrame>();
    const [a, b] = [frame(0), frame(40_000)];
    p.push(a);
    p.push(b);
    p.select(0);
    p.clear();
    expect(a.closed && b.closed).toBe(true);
    expect(p.current).toBeNull();
    expect(p.size).toBe(0);
  });
});
