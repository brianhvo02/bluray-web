import { describe, expect, it } from 'vitest';
import { keyToAction } from './keyboard';

describe('keyToAction', () => {
  it('maps the playback keys from the spec', () => {
    expect(keyToAction(' ')).toEqual({ type: 'togglePlay' });
    expect(keyToAction('ArrowLeft')).toEqual({ type: 'seekBy', deltaUs: -10_000_000 });
    expect(keyToAction('ArrowRight')).toEqual({ type: 'seekBy', deltaUs: 10_000_000 });
    expect(keyToAction('ArrowUp')).toEqual({ type: 'volumeBy', delta: 0.1 });
    expect(keyToAction('ArrowDown')).toEqual({ type: 'volumeBy', delta: -0.1 });
    expect(keyToAction('f')).toEqual({ type: 'fullscreen' });
    expect(keyToAction('F')).toEqual({ type: 'fullscreen' });
    expect(keyToAction('x')).toBeNull();
  });
});
