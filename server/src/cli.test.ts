import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { printNasId } from './cli';
import { RendezvousClient } from './rendezvous-client';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cli-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('printNasId', () => {
  it("prints the thumbprint of the NAS's rendezvous key, the id the Worker knows it by", async () => {
    const keyFile = join(tmp, 'rendezvous-key.json');
    const client = new RendezvousClient('https://rendezvous.example/', keyFile, (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch);
    const expected = await client.localNasId();
    const lines: string[] = [];
    expect(await printNasId(keyFile, (line) => lines.push(line))).toBe(expected);
    expect(lines[0]).toBe(`NAS id: ${expected}`);
    expect(lines.join('\n')).toContain('TURN_NAS_IDS');
    expect(expected).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('says so, and makes no key, when there is none yet', async () => {
    const lines: string[] = [];
    const keyFile = join(tmp, 'rendezvous-key.json');
    expect(await printNasId(keyFile, (line) => lines.push(line))).toBeNull();
    expect(lines.join('\n')).toMatch(/no rendezvous key/i);
    await expect(import('node:fs').then((fs) => fs.existsSync(keyFile))).resolves.toBe(false);
  });

});
