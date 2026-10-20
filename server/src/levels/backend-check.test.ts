import { spawnSync, type spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { RENDER_NODE, SELF_TEST_TIMEOUT_MS, levelsBackend } from './backend-check';
import { qsvBackend, x264Backend } from './encoder';

const CONFIG = { ffmpegPath: '/opt/ffmpeg/ffmpeg' };

/** A stand-in for ffmpeg that exits with `code` (or never, for null) and records its arguments. */
function fakeSpawn(code: number | null, stderr = ''): typeof nodeSpawn & { calls: { binary: string; args: string[] }[]; killed: boolean } {
  const calls: { binary: string; args: string[] }[] = [];
  const fn = ((binary: string, args: string[]) => {
    calls.push({ binary, args });
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => {
        fn.killed = true;
        setImmediate(() => child.emit('close', null, 'SIGKILL'));
        return true;
      },
    });
    if (code !== null) {
      setImmediate(() => {
        child.stderr.end(stderr);
        child.emit('close', code, null);
      });
    }
    return child;
  }) as unknown as typeof nodeSpawn & { calls: { binary: string; args: string[] }[]; killed: boolean };
  fn.calls = calls;
  fn.killed = false;
  return fn;
}

describe('levelsBackend', () => {
  it('is off without a word to ffmpeg when LEVELS_BACKEND=off', async () => {
    const spawn = fakeSpawn(0);
    const logs: string[] = [];
    expect(await levelsBackend({ ...CONFIG, backend: 'off' }, { spawn, log: (m) => logs.push(m) })).toBeNull();
    expect(spawn.calls).toEqual([]);
    expect(logs).toEqual(['quality levels: off (LEVELS_BACKEND=off); only Original is offered']);
  });

  it('is off when there is no render node for qsv', async () => {
    const spawn = fakeSpawn(0);
    const logs: string[] = [];
    expect(await levelsBackend({ ...CONFIG, backend: 'qsv' }, { spawn, exists: () => false, log: (m) => logs.push(m) })).toBeNull();
    expect(spawn.calls).toEqual([]);
    expect(logs).toEqual([`quality levels: off; no ${RENDER_NODE} for Quick Sync, so only Original is offered`]);
  });

  it('runs a 1 s testsrc encode with h264_qsv on the render node, and gives the qsv backend with FFMPEG_PATH', async () => {
    const spawn = fakeSpawn(0);
    const logs: string[] = [];
    const seen: string[] = [];
    const backend = await levelsBackend({ ...CONFIG, backend: 'qsv' }, { spawn, exists: (p) => (seen.push(p), true), log: (m) => logs.push(m) });
    expect(seen).toEqual([RENDER_NODE]);
    expect(backend?.binary).toBe('/opt/ffmpeg/ffmpeg');
    expect(backend?.args).toBe(qsvBackend.args);
    expect(spawn.calls).toHaveLength(1);
    const { binary, args } = spawn.calls[0]!;
    expect(binary).toBe('/opt/ffmpeg/ffmpeg');
    expect(args.join(' ')).toContain(`-init_hw_device vaapi=va:${RENDER_NODE} -init_hw_device qsv=hw@va -filter_hw_device hw`);
    expect(args.join(' ')).toContain('-f lavfi -i testsrc=duration=1');
    expect(args.join(' ')).toContain('-c:v h264_qsv');
    expect(args.slice(-3)).toEqual(['-f', 'null', '-']);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^quality levels: qsv \(h264_qsv self-test passed in \d+ ms\)$/);
  });

  it('is off when the qsv self-test fails, with ffmpeg’s last line in the log', async () => {
    const spawn = fakeSpawn(1, 'some noise\n[h264_qsv @ 0x1] Error initializing an internal MFX session: unsupported (-3)\n');
    const logs: string[] = [];
    expect(await levelsBackend({ ...CONFIG, backend: 'qsv' }, { spawn, exists: () => true, log: (m) => logs.push(m) })).toBeNull();
    expect(logs).toEqual([
      'quality levels: off; the h264_qsv self-test failed (exit 1: [h264_qsv @ 0x1] Error initializing an internal MFX session: unsupported (-3)), so only Original is offered',
    ]);
  });

  it('is off when the self-test runs past 10 s, and kills it', async () => {
    expect(SELF_TEST_TIMEOUT_MS).toBe(10_000);
    const spawn = fakeSpawn(null);
    const logs: string[] = [];
    expect(await levelsBackend({ ...CONFIG, backend: 'qsv' }, { spawn, exists: () => true, log: (m) => logs.push(m), timeoutMs: 5 })).toBeNull();
    expect(spawn.killed).toBe(true);
    expect(logs).toEqual(['quality levels: off; the h264_qsv self-test failed (no answer in 10 s), so only Original is offered']);
  });

  it('is off when ffmpeg is missing', async () => {
    const logs: string[] = [];
    const backend = await levelsBackend({ ffmpegPath: '/nonexistent/ffmpeg', backend: 'x264' }, { log: (m) => logs.push(m) });
    expect(backend).toBeNull();
    expect(logs[0]).toMatch(/^quality levels: off; the libx264 self-test failed \(ffmpeg did not start: .*ENOENT.*\), so only Original is offered$/);
  });

  it('tests libx264 for LEVELS_BACKEND=x264, with no render node needed', async () => {
    const spawn = fakeSpawn(0);
    const logs: string[] = [];
    const backend = await levelsBackend({ ...CONFIG, backend: 'x264' }, { spawn, exists: () => false, log: (m) => logs.push(m) });
    expect(backend?.binary).toBe('/opt/ffmpeg/ffmpeg');
    expect(backend?.args).toBe(x264Backend.args);
    expect(spawn.calls[0]!.args.join(' ')).toContain('-c:v libx264');
    expect(logs[0]).toMatch(/^quality levels: x264 \(libx264 self-test passed in \d+ ms\)$/);
  });

  const hasX264 = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout?.includes('libx264') ?? false;
  it.skipIf(!hasX264 && !process.env.CI)('passes the libx264 self-test with the real ffmpeg', async () => {
    const logs: string[] = [];
    expect(await levelsBackend({ ffmpegPath: 'ffmpeg', backend: 'x264' }, { log: (m) => logs.push(m) })).not.toBeNull();
    expect(logs[0]).toMatch(/self-test passed/);
  }, 15_000);
});
