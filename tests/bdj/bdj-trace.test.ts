import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compareBdjTraces } from './compare';
import { parseBdjTrace } from './format';
import { RegisterFile } from '../../src/engine/hdmv/registers';
import { applyHarnessSettings, replayBdj } from './replay';

describe('BD-J trace parity', () => {
  it('disc-bdj makes the control calls libbluray makes', async () => {
    const golden = parseBdjTrace(readFileSync(new URL('./golden/disc-bdj.jsonl', import.meta.url), 'utf8'));
    const { trace, bootMs, untilMs } = await replayBdj('fixtures/synthetic/disc-bdj', { until: 'selectPlaylistN' });
    console.log(`disc-bdj replay: boot ${bootMs.toFixed(0)} ms, until selectPlaylistN ${untilMs.toFixed(0)} ms`);
    compareBdjTraces(golden, trace);
  }, 120_000);

  it("sets the harness's player settings: country us, audio, PG and menu language eng", () => {
    const regs = new RegisterFile();
    applyHarnessSettings(regs);
    expect([16, 17, 18, 19].map((i) => regs.psrRead(i))).toEqual([0x656e67, 0x656e67, 0x656e67, 0x7573]);
  });

  it('reports a timed-out run explicitly', async () => {
    await expect(replayBdj('fixtures/synthetic/disc-bdj', { until: 'selectPlaylistN', timeoutMs: 1 })).rejects.toThrow(/timed out after 1 ms|ended 'aborted' before selectPlaylistN \(timed out: true/);
  }, 120_000);

  it('reports a run that ends before the until call explicitly', async () => {
    await expect(replayBdj('fixtures/synthetic/disc-bdj', { until: 'noSuchCallN' })).rejects.toThrow(/run ended '(idle|deadlock)' before noSuchCallN \(timed out: false, exit status none, \d+ calls traced\)/);
  }, 120_000);
});
