import { describe, expect, it } from 'vitest';
import { shouldPromptUpdate } from './update-prompt';

describe('shouldPromptUpdate', () => {
  it('waits while the engine is playing', () => {
    expect(shouldPromptUpdate({ waiting: true, engineState: 'playing' })).toBe(false);
  });

  it('waits while the engine is buffering', () => {
    expect(shouldPromptUpdate({ waiting: true, engineState: 'buffering' })).toBe(false);
  });

  it('prompts when a new worker is waiting and playback is paused', () => {
    expect(shouldPromptUpdate({ waiting: true, engineState: 'paused' })).toBe(true);
  });

  it('prompts on the landing screen', () => {
    expect(shouldPromptUpdate({ waiting: true, engineState: 'idle' })).toBe(true);
  });

  it('never prompts without a waiting worker', () => {
    expect(shouldPromptUpdate({ waiting: false, engineState: 'paused' })).toBe(false);
  });
});
