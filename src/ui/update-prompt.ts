import type { PlaybackState } from '../engine/protocol';

/**
 * Whether to offer the waiting service worker's new version. A reload would stop playback,
 * so the prompt waits until the engine is neither playing nor buffering.
 */
export function shouldPromptUpdate(state: { waiting: boolean; engineState: PlaybackState }): boolean {
  return state.waiting && state.engineState !== 'playing' && state.engineState !== 'buffering';
}
