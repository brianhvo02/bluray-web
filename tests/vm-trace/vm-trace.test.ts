import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compareTraces } from './compare';
import { parseTrace } from './format';
import { replay } from './replay';

const GOLDEN = new URL('./golden/', import.meta.url);
const SCRIPTS = new URL('./scripts/', import.meta.url);

describe('libbluray trace parity', () => {
  for (const name of readdirSync(GOLDEN).filter((f) => f.endsWith('.jsonl'))) {
    it(`matches libbluray: ${name}`, async () => {
      const [disc, script] = name.replace('.jsonl', '').split('.');
      const ours = await replay(new URL(`../../fixtures/synthetic/${disc}`, import.meta.url), readFileSync(new URL(`${disc}.${script}.keys`, SCRIPTS), 'utf8'));
      expect(() => compareTraces(parseTrace(readFileSync(new URL(name, GOLDEN), 'utf8')), ours)).not.toThrow();
    }, 60_000);
  }
});
