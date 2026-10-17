import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { fixtureDiscFiles } from '../../../tests/helpers/fixture-disc';
import { VirtualClock, assembleClass, storedZip } from '../../../tests/helpers/jvm-asm';
import { discEntries } from '../../../tests/helpers/synthetic-disc';
import { runBdjWorker, type BdjWorkerHandle } from './bdj-worker';
import { ZipArchive } from './jvm/zip';
import { BdjEvent, type ClassLibrarySource } from './runtime';
import { BdjSession, type BdjFailureCode, type WorkerLike } from './session';
import { createRegisterBuffer } from './shared-registers';
import { StatusBlockReader, StatusBlockWriter, createStatusBlock } from './status-block';
import type { BdjCallName, BdjWireValue, FromBdj, ToBdj } from './worker-protocol';

const file = (rel: string): Uint8Array => new Uint8Array(readFileSync(fileURLToPath(new URL(rel, import.meta.url))));
const CLASSES: ClassLibrarySource = {
  rt: file('../../bdj-classlib/rt-bdj.jar'),
  libbluray: file('../../bdj-classlib/libbluray-j2se.jar'),
  libblurayAwt: file('../../bdj-classlib/libbluray-awt-j2se.jar'),
};
/** libbluray's control calls on disc-bdj through the first selectPlaylistN (the golden goes on to the second). */
const GOLDEN = ((lines: string[]) => lines.slice(0, lines.findIndex((l) => l.includes('"call":"selectPlaylistN"')) + 1))(
  new TextDecoder()
    .decode(file('../../../tests/bdj/golden/disc-bdj.jsonl'))
    .split('\n')
    .filter((l) => l !== ''),
);
const GOLDEN_RETURNS: Partial<Record<BdjCallName, number>> = { writeReg: 0, selectPlaylist: 1 };
const FIRST_PLAY = 0xffff;
const DISC_FILES = discEntries(fixtureDiscFiles('disc-bdj'));
const INVOKESTATIC = 0xb8, ICONST_3 = 0x06, RETURN = 0xb1;

type Call = { readonly name: BdjCallName; readonly args: readonly BdjWireValue[] };

/** The engine end of an in-process BD-J worker over a MessageChannel. */
function inProcessWorker(): { readonly worker: WorkerLike; readonly handle: BdjWorkerHandle; readonly terminated: () => boolean } {
  const { port1, port2 } = new MessageChannel();
  const handle = runBdjWorker(port2 as unknown as Parameters<typeof runBdjWorker>[0]);
  let terminated = false;
  const worker: WorkerLike = {
    postMessage: (m: ToBdj) => port1.postMessage(m),
    set onmessage(fn: ((e: MessageEvent<FromBdj>) => void) | null) {
      port1.onmessage = fn as ((e: MessageEvent) => void) | null;
    },
    get onmessage() {
      return port1.onmessage as ((e: MessageEvent<FromBdj>) => void) | null;
    },
    terminate: () => {
      terminated = true;
      port1.close();
      port2.close();
    },
  };
  return { worker, handle, terminated: () => terminated };
}

/** A worker the test drives by hand. */
function fakeWorker(): { readonly worker: WorkerLike; readonly sent: ToBdj[]; emit(m: FromBdj): void; readonly terminated: () => boolean } {
  const sent: ToBdj[] = [];
  let terminated = false;
  const worker: WorkerLike = {
    postMessage: (m) => void sent.push(m),
    onmessage: null,
    terminate: () => void (terminated = true),
  };
  return { worker, sent, emit: (m) => worker.onmessage?.({ data: m } as MessageEvent<FromBdj>), terminated: () => terminated };
}

interface Harness {
  readonly session: BdjSession;
  readonly calls: Call[];
  readonly failures: [BdjFailureCode, string][];
  readonly logs: string[];
  readonly clock: VirtualClock;
  readonly status: StatusBlockReader;
}

const sessions: BdjSession[] = [];
afterEach(() => {
  for (const s of sessions.splice(0)) s.stop();
});

function session(worker: WorkerLike, answer: (c: Call) => number | string = (c) => GOLDEN_RETURNS[c.name] ?? 0, time45 = 0n): Harness {
  const calls: Call[] = [];
  const failures: [BdjFailureCode, string][] = [];
  const logs: string[] = [];
  const clock = new VirtualClock();
  const statusBuf = createStatusBlock();
  const s = new BdjSession({
    worker,
    host: {
      handle: (name, args) => {
        calls.push({ name, args });
        return Promise.resolve(answer({ name, args }));
      },
    },
    regs: createRegisterBuffer(),
    status: new StatusBlockWriter(statusBuf),
    time45: () => time45,
    onFailed: (code, message) => void failures.push([code, message]),
    onLog: (line) => void logs.push(line),
    nowMs: clock.nowMs,
    setTimer: clock.setTimer,
  });
  sessions.push(s);
  return { session: s, calls, failures, logs, clock, status: new StatusBlockReader(statusBuf) };
}

async function until(cond: () => boolean, ms = 60_000): Promise<void> {
  const end = performance.now() + ms;
  while (!cond()) {
    if (performance.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const asGolden = (c: Call): string => JSON.stringify({ call: `${c.name}N`, args: c.args, ret: c.name in GOLDEN_RETURNS ? GOLDEN_RETURNS[c.name] : null });

describe('BdjSession with the in-process BD-J worker on disc-bdj', () => {
  it("boots, starts First Play and answers the golden's control calls in order through the host", async () => {
    const w = inProcessWorker();
    const h = session(w.worker, undefined, 4500n);
    await h.session.boot(DISC_FILES, null, CLASSES);
    expect(h.logs.some((l) => l.includes("Using Java 1.8 (5b) from '/jdk'"))).toBe(true);
    h.session.start(FIRST_PLAY);
    await until(() => h.calls.some((c) => c.name === 'selectPlaylist'));
    // the golden ends at the first selectPlaylistN; Java goes on past it
    const first = h.calls.findIndex((c) => c.name === 'selectPlaylist');
    expect(h.calls.slice(0, first + 1).map(asGolden)).toEqual(GOLDEN);
    expect(h.status.time45()).toBe(4500n);
    expect(h.logs.some((l) => l.endsWith(': FirstPlayXlet: start'))).toBe(true);
    expect(h.logs.filter((l) => l.endsWith(': TitleXlet: start'))).toHaveLength(1);
    expect(h.clock.pending).toBe(0);
    expect(h.failures).toEqual([]);
  }, 60_000);

  it('reports class-not-found when the class library lacks org/videolan/Libbluray', async () => {
    const z = ZipArchive.open(CLASSES.libbluray);
    const entries = z.names.filter((n) => n !== 'org/videolan/Libbluray.class').map((n) => [n, z.read(n)!] as const);
    const w = inProcessWorker();
    const h = session(w.worker);
    await h.session.boot(DISC_FILES, null, { ...CLASSES, libbluray: storedZip(entries) });
    expect(h.failures).toHaveLength(1);
    expect(h.failures[0]![0]).toBe('class-not-found');
    expect(h.failures[0]![1]).toContain('org/videolan/Libbluray');
    expect(w.terminated()).toBe(true);
  }, 60_000);

  it('reports halted when the JVM halts mid-title, and later engine events do not throw', async () => {
    const w = inProcessWorker();
    const h = session(w.worker);
    await h.session.boot(DISC_FILES, null, CLASSES);
    h.session.start(FIRST_PLAY);
    await until(() => h.calls.some((c) => c.name === 'selectPlaylist'));
    const rt = w.handle.runtime!;
    const cls = rt.jvm.loader.define('bdjweb/Halt', assembleClass('bdjweb/Halt', [{
      name: 'go',
      desc: '()V',
      code: [
        // Shutdown.halt, below Runtime.halt's security check (BDJSecurityManager denies exit to xlets)
        ICONST_3, INVOKESTATIC, { c: ['method', 'java/lang/Shutdown', 'halt', '(I)V'] }, RETURN,
      ],
    }]), null, null);
    rt.jvm.threads.spawn(rt.jvm.mainThread, cls.methods.get('go()V')!, []);
    h.session.event(BdjEvent.PSR102, 1);
    await until(() => h.failures.length > 0);
    expect(h.failures).toEqual([['halted', 'the JVM halted with status 3']]);
    expect(rt.exitStatus).toBe(3);
    expect(w.terminated()).toBe(true);
    expect(() => {
      h.session.event(BdjEvent.PTS, 100);
      h.session.start(1);
    }).not.toThrow();
    expect(h.failures).toHaveLength(1);
  }, 60_000);
});

describe('BdjSession rules', () => {
  it('fails with timeout when no playlist is selected within 20,000 ms of start', () => {
    const f = fakeWorker();
    const h = session(f.worker);
    void h.session.boot(DISC_FILES, null, CLASSES);
    f.emit({ type: 'booted', bootMs: 10 });
    h.session.start(FIRST_PLAY);
    f.emit({ type: 'call', id: 1, name: 'selectPlaylist', args: [-1, -1, -1, '-1'] }); // a close is no selection
    h.clock.advance(19_999);
    expect(h.failures).toEqual([]);
    h.clock.advance(1);
    expect(h.failures.map(([c]) => c)).toEqual(['timeout']);
    expect(f.terminated()).toBe(true);
  });

  it('fails with timeout 20,000 ms after a boot that never completes', async () => {
    const f = fakeWorker();
    const h = session(f.worker);
    const booted = h.session.boot(DISC_FILES, null, CLASSES);
    h.clock.advance(19_999);
    expect(h.failures).toEqual([]);
    h.clock.advance(1);
    expect(h.failures.map(([c]) => c)).toEqual(['timeout']);
    expect(f.terminated()).toBe(true);
    await booted; // settles at the stop
  });

  it('a selected playlist cancels the timeout', async () => {
    const f = fakeWorker();
    const h = session(f.worker);
    h.session.start(FIRST_PLAY);
    f.emit({ type: 'call', id: 1, name: 'selectPlaylist', args: [0, -1, -1, '-1'] });
    h.clock.advance(60_000);
    expect(h.failures).toEqual([]);
    await until(() => f.sent.some((m) => m.type === 'reply'));
    expect(f.sent.at(-1)).toEqual({ type: 'reply', id: 1, value: 1 });
  });

  it('ignores messages after stop() and terminates the worker', async () => {
    const f = fakeWorker();
    const h = session(f.worker);
    const booted = h.session.boot(DISC_FILES, null, CLASSES);
    h.session.start(FIRST_PLAY);
    const sent = f.sent.length;
    h.session.stop();
    expect(f.terminated()).toBe(true);
    await booted; // a pending boot settles at stop
    f.emit({ type: 'call', id: 1, name: 'writeReg', args: [1, 4, 1, -1] });
    f.emit({ type: 'failed', code: 'internal', message: 'late' });
    f.emit({ type: 'log', line: 'late', error: false });
    h.session.event(BdjEvent.PTS, 1);
    h.session.start(1);
    h.clock.advance(30_000);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.calls).toEqual([]);
    expect(h.failures).toEqual([]);
    expect(h.logs).not.toContain('late');
    expect(f.sent.length).toBe(sent);
  });

  it('sends a title start the host asks for during selectTitle only after that call is answered', async () => {
    const f = fakeWorker();
    let s: BdjSession | null = null;
    const h = session(f.worker, (c) => {
      if (c.name === 'selectTitle') {
        s!.start(2);
        s!.event(BdjEvent.PSR102, 5);
      }
      return 1;
    });
    s = h.session;
    f.emit({ type: 'call', id: 7, name: 'selectTitle', args: [2] });
    expect(f.sent).toEqual([]);
    await until(() => f.sent.length === 3);
    expect(f.sent).toEqual([
      { type: 'reply', id: 7, value: 1 },
      { type: 'start', title: 2 },
      { type: 'event', ev: BdjEvent.PSR102, param: 5 },
    ]);
  });

  it('publishes the time before replying to seek', async () => {
    const f = fakeWorker();
    const h = session(f.worker, () => '1', 9000n);
    f.emit({ type: 'call', id: 3, name: 'seek', args: [-1, -1, '18000'] });
    await until(() => f.sent.length === 1);
    expect(h.status.time45()).toBe(9000n);
    expect(f.sent).toEqual([{ type: 'reply', id: 3, value: '1' }]);
  });

  it("reports a worker's failure once and stops", () => {
    const f = fakeWorker();
    const h = session(f.worker);
    f.emit({ type: 'failed', code: 'unsatisfied-link', message: 'x' });
    f.emit({ type: 'failed', code: 'internal', message: 'y' });
    expect(h.failures).toEqual([['unsatisfied-link', 'x']]);
    expect(f.terminated()).toBe(true);
  });
});
