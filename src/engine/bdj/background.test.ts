import { describe, expect, it } from 'vitest';
import { BackgroundStill, type ShownStill } from './background';

/** A stand-in ImageBitmap that records its close. */
function fakeBitmap(name: string): ImageBitmap & { closed: boolean; name: string } {
  const b = { name, width: 1920, height: 1080, closed: false, close: () => void (b.closed = true) };
  return b as unknown as ImageBitmap & { closed: boolean; name: string };
}

/** A decoder whose decodes the test settles by hand, in any order. */
function manualDecoder() {
  const pending: { bytes: Uint8Array; resolve: (b: ImageBitmap) => void; reject: (e: Error) => void }[] = [];
  const decode = (bytes: Uint8Array): Promise<ImageBitmap> => new Promise((resolve, reject) => pending.push({ bytes, resolve, reject }));
  return { decode, pending };
}

const FULL = { x: 0, y: 0, width: 1, height: 1 };
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('BackgroundStill', () => {
  it('shows a decoded still and closes it when a newer one replaces it', async () => {
    const { decode, pending } = manualDecoder();
    const changes: (ShownStill | null)[] = [];
    const bg = new BackgroundStill({ decode, onChange: (s) => changes.push(s) });
    bg.show(new Uint8Array([1]), FULL);
    expect(pending[0]!.bytes).toEqual(new Uint8Array([1]));
    const a = fakeBitmap('a');
    pending[0]!.resolve(a);
    await flush();
    expect(changes).toEqual([{ image: a, rect: FULL }]);
    expect(bg.current?.image).toBe(a);

    bg.show(new Uint8Array([2]), { x: 0.25, y: 0, width: 0.5, height: 1 });
    await flush();
    expect(a.closed).toBe(false); // still shown while the new one decodes
    const b = fakeBitmap('b');
    pending[1]!.resolve(b);
    await flush();
    expect(changes.at(-1)).toEqual({ image: b, rect: { x: 0.25, y: 0, width: 0.5, height: 1 } });
    expect(a.closed).toBe(true);
    expect(b.closed).toBe(false);
  });

  it('closes a decode that finishes after a newer still or a clear, without showing it', async () => {
    const { decode, pending } = manualDecoder();
    const changes: (ShownStill | null)[] = [];
    const bg = new BackgroundStill({ decode, onChange: (s) => changes.push(s) });
    bg.show(new Uint8Array([1]), FULL);
    bg.show(new Uint8Array([2]), FULL);
    const second = fakeBitmap('second');
    pending[1]!.resolve(second);
    const first = fakeBitmap('first');
    pending[0]!.resolve(first);
    await flush();
    expect(changes).toEqual([{ image: second, rect: FULL }]);
    expect(first.closed).toBe(true);

    bg.show(new Uint8Array([3]), FULL);
    bg.clear();
    const third = fakeBitmap('third');
    pending[2]!.resolve(third);
    await flush();
    expect(third.closed).toBe(true);
    expect(second.closed).toBe(true);
    expect(changes.at(-1)).toBeNull();
    expect(bg.current).toBeNull();
  });

  it('clear tells the compositor before closing the bitmap, and clearing nothing is silent', async () => {
    const { decode, pending } = manualDecoder();
    const log: string[] = [];
    const bg = new BackgroundStill({ decode, onChange: (s) => log.push(s ? 'show' : 'hide') });
    bg.clear();
    expect(log).toEqual([]);
    bg.show(new Uint8Array([1]), FULL);
    const a = fakeBitmap('a');
    const close = a.close.bind(a);
    a.close = () => {
      log.push('close');
      close();
    };
    pending[0]!.resolve(a);
    await flush();
    bg.clear();
    expect(log).toEqual(['show', 'hide', 'close']);
  });

  it('a still that cannot be decoded clears the background and is reported', async () => {
    const { decode, pending } = manualDecoder();
    const errors: string[] = [];
    const changes: (ShownStill | null)[] = [];
    const bg = new BackgroundStill({ decode, onChange: (s) => changes.push(s), onError: (m) => errors.push(m) });
    bg.show(new Uint8Array([1]), FULL);
    const a = fakeBitmap('a');
    pending[0]!.resolve(a);
    await flush();
    bg.show(new Uint8Array([0xde, 0xad]), FULL);
    pending[1]!.reject(new Error('not an image'));
    await flush();
    expect(errors).toEqual(['a background image could not be decoded: not an image']);
    expect(changes.at(-1)).toBeNull();
    expect(a.closed).toBe(true);
  });

  it('a decoder that throws at once is a failed decode', async () => {
    const errors: string[] = [];
    const bg = new BackgroundStill({
      decode: () => {
        throw new Error('no decoder');
      },
      onChange: () => undefined,
      onError: (m) => errors.push(m),
    });
    bg.show(new Uint8Array([1]), FULL);
    await flush();
    expect(errors).toEqual(['a background image could not be decoded: no decoder']);
  });

  it('a rectangle with non-finite fields falls back to the whole screen in those fields', async () => {
    const { decode, pending } = manualDecoder();
    const bg = new BackgroundStill({ decode, onChange: () => undefined });
    bg.show(new Uint8Array([1]), { x: Number.NaN, y: 0.5, width: Number.POSITIVE_INFINITY, height: 0.5 });
    pending[0]!.resolve(fakeBitmap('a'));
    await flush();
    expect(bg.current?.rect).toEqual({ x: 0, y: 0.5, width: 1, height: 0.5 });
  });
});
