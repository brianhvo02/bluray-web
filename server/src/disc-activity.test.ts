import { describe, expect, it } from 'vitest';
import { DiscActivity } from './disc-activity';

describe('DiscActivity', () => {
  it('is not busy before any read', () => {
    expect(new DiscActivity(() => 1_000_000).busy()).toBe(false);
  });

  it('is busy within 120 s of a note and not after', () => {
    let now = 1_000_000;
    const activity = new DiscActivity(() => now);
    activity.note();
    now += 119_999;
    expect(activity.busy()).toBe(true);
    now += 2;
    expect(activity.busy()).toBe(false);
    activity.note();
    expect(activity.busy()).toBe(true);
  });

  it('takes its own window', () => {
    let now = 5;
    const activity = new DiscActivity(() => now);
    activity.note();
    now += 1_000;
    expect(activity.busy(500)).toBe(false);
    expect(activity.busy(2_000)).toBe(true);
  });
});
