import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { compareBdjTraces } from './compare';
import { parseBdjTrace } from './format';
import { replayBdj } from './replay';

describe('BD-J trace parity', () => {
  it('disc-bdj makes the control calls libbluray makes', async () => {
    const golden = parseBdjTrace(readFileSync(new URL('./golden/disc-bdj.jsonl', import.meta.url), 'utf8'));
    const { trace, bootMs, untilMs } = await replayBdj('fixtures/synthetic/disc-bdj', { until: 'selectPlaylistN' });
    console.log(`disc-bdj replay: boot ${bootMs.toFixed(0)} ms, until selectPlaylistN ${untilMs.toFixed(0)} ms`);
    compareBdjTraces(golden, trace);
  }, 120_000);
});
