export type KeyAction =
  | { readonly type: 'togglePlay' }
  | { readonly type: 'seekBy'; readonly deltaUs: number }
  | { readonly type: 'volumeBy'; readonly delta: number }
  | { readonly type: 'fullscreen' }
  | { readonly type: 'cycleAudio' };

/** Playback keys (spec §7), plus A (audio track). Menu keys (arrows/Enter/digits to IG, M, P) arrive in M3; subtitle keys in M4. */
export function keyToAction(key: string): KeyAction | null {
  switch (key) {
    case ' ':
      return { type: 'togglePlay' };
    case 'ArrowLeft':
      return { type: 'seekBy', deltaUs: -10_000_000 };
    case 'ArrowRight':
      return { type: 'seekBy', deltaUs: 10_000_000 };
    case 'ArrowUp':
      return { type: 'volumeBy', delta: 0.1 };
    case 'ArrowDown':
      return { type: 'volumeBy', delta: -0.1 };
    case 'f':
    case 'F':
      return { type: 'fullscreen' };
    case 'a':
    case 'A':
      return { type: 'cycleAudio' };
    default:
      return null;
  }
}
