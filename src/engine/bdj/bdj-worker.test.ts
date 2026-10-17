import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { fixtureDiscFiles } from '../../../tests/helpers/fixture-disc';
import { discEntries } from '../../../tests/helpers/synthetic-disc';
import { runBdjWorker, type BdjPort } from './bdj-worker';
import { createRegisterBuffer } from './shared-registers';
import { createStatusBlock } from './status-block';
import type { FromBdj, ToBdj } from './worker-protocol';

const jar = (name: string): Uint8Array => new Uint8Array(readFileSync(fileURLToPath(new URL(`../../bdj-classlib/${name}`, import.meta.url))));

describe('runBdjWorker', () => {
  it("gives Java the wall clock: System.currentTimeMillis is the epoch time, as libbluray's JVM has it", async () => {
    const received: FromBdj[] = [];
    const port: BdjPort = { onmessage: null, postMessage: (m) => void received.push(m) };
    const handle = runBdjWorker(port);
    const boot: ToBdj = {
      type: 'boot',
      registers: createRegisterBuffer(),
      status: createStatusBlock(),
      discFiles: discEntries(fixtureDiscFiles('disc-bdj')),
      discId: null,
      classLibrary: { rt: jar('rt-bdj.jar'), libbluray: jar('libbluray-j2se.jar'), libblurayAwt: jar('libbluray-awt-j2se.jar') },
    };
    port.onmessage!({ data: boot });
    await vi.waitFor(() => expect(received.map((m) => m.type)).toContain('booted'), { timeout: 60_000 });
    // a signed disc jar's certificates are checked against this clock (JarVerifier); 1970 sends them down another path
    const now = handle.runtime!.jvm.opts.nowMs();
    expect(Math.abs(now - Date.now())).toBeLessThan(5_000);
    port.onmessage!({ data: { type: 'stop' } });
  }, 90_000);
});
