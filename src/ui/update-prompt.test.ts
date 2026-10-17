import { describe, expect, it } from 'vitest';
import { isWaitingWorker, reloadAction, shouldPromptUpdate } from './update-prompt';

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

describe('isWaitingWorker', () => {
  it('counts only an installed worker as waiting', () => {
    expect(isWaitingWorker('installed')).toBe(true);
    for (const state of ['parsed', 'installing', 'activating', 'activated', 'redundant'] as const) {
      expect(isWaitingWorker(state)).toBe(false);
    }
  });
});

describe('reloadAction', () => {
  it('asks a waiting worker to take over', () => {
    expect(reloadAction('installed')).toBe('skip-waiting');
  });

  it('reloads at once when another tab already let the worker take over', () => {
    expect(reloadAction('activating')).toBe('reload');
    expect(reloadAction('activated')).toBe('reload');
  });
});
