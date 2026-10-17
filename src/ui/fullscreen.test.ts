import { describe, expect, it, vi } from 'vitest';
import { FULLSCREEN_HINT_KEY, isFullscreenHintDismissed, markFullscreenHintDismissed, shouldShowFullscreenHint, toggleFullscreen } from './fullscreen';

function fakes(doc: Record<string, unknown>): { doc: Document; el: HTMLElement; el_: Record<string, ReturnType<typeof vi.fn>> } {
  const el_ = { requestFullscreen: vi.fn(), webkitRequestFullscreen: vi.fn() };
  const d = { exitFullscreen: vi.fn(), webkitExitFullscreen: vi.fn(), ...doc };
  return { doc: d as unknown as Document, el: el_ as unknown as HTMLElement, el_ };
}

describe('toggleFullscreen', () => {
  it('standard: requests fullscreen on the element', () => {
    const { doc, el, el_ } = fakes({ fullscreenElement: null });
    toggleFullscreen(doc, el, 'standard');
    expect(el_.requestFullscreen).toHaveBeenCalled();
  });
  it('standard: exits when fullscreen is active', () => {
    const { doc, el, el_ } = fakes({ fullscreenElement: {} });
    toggleFullscreen(doc, el, 'standard');
    expect((doc as unknown as { exitFullscreen: unknown }).exitFullscreen).toHaveBeenCalled();
    expect(el_.requestFullscreen).not.toHaveBeenCalled();
  });
  it('webkit: requests with the prefixed API', () => {
    const { doc, el, el_ } = fakes({ webkitFullscreenElement: null });
    toggleFullscreen(doc, el, 'webkit');
    expect(el_.webkitRequestFullscreen).toHaveBeenCalled();
    expect(el_.requestFullscreen).not.toHaveBeenCalled();
  });
  it('webkit: exits with the prefixed API when webkitFullscreenElement is set', () => {
    const { doc, el, el_ } = fakes({ webkitFullscreenElement: {} });
    toggleFullscreen(doc, el, 'webkit');
    expect((doc as unknown as { webkitExitFullscreen: unknown }).webkitExitFullscreen).toHaveBeenCalled();
    expect(el_.webkitRequestFullscreen).not.toHaveBeenCalled();
  });
});

describe('shouldShowFullscreenHint', () => {
  const base = { fullscreen: null, coarsePointer: true, standalone: false, dismissed: false } as const;
  it('shows on a coarse-pointer browser tab without fullscreen', () => {
    expect(shouldShowFullscreenHint(base)).toBe(true);
  });
  it.each([
    { fullscreen: 'standard' as const },
    { fullscreen: 'webkit' as const },
    { coarsePointer: false },
    { standalone: true },
    { dismissed: true },
  ])('hides for %j', (override) => {
    expect(shouldShowFullscreenHint({ ...base, ...override })).toBe(false);
  });
});

describe('hint dismissal storage', () => {
  it('round-trips through storage', () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    expect(isFullscreenHintDismissed(storage)).toBe(false);
    markFullscreenHintDismissed(storage);
    expect(data.has(FULLSCREEN_HINT_KEY)).toBe(true);
    expect(isFullscreenHintDismissed(storage)).toBe(true);
  });
  it('survives storage that throws', () => {
    const storage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(isFullscreenHintDismissed(storage)).toBe(false);
    expect(() => markFullscreenHintDismissed(storage)).not.toThrow();
  });
});
