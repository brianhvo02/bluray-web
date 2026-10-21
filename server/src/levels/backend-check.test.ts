import { spawnSync, type spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { RENDER_NODE, SELF_TEST_TIMEOUT_MS, levelsBackend } from './backend-check';
import { qsvBackend, x264Backend } from './encoder';

const CONFIG = { ffmpegPath: '/opt/ffmpeg/ffmpeg' };

type Exit = { code: number | null; stderr?: string };

/**
 * A stand-in for ffmpeg that records its arguments and exits as `exit` says for them (a code of null: never, until
 * killed).
 */
function fakeSpawn(exit: Exit | ((args: string[]) => Exit)): typeof nodeSpawn & { calls: { binary: string; args: string[] }[]; killed: boolean } {
  const calls: { binary: string; args: string[] }[] = [];
  const fn = ((binary: string, args: string[]) => {
    calls.push({ binary, args });
    const { code, stderr = '' } = typeof exit === 'function' ? exit(args) : exit;
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

const ok: Exit = { code: 0 };
const hevcFails = (args: string[]): Exit => (args.includes('hevc_qsv') ? { code: 1, stderr: '[hevc_qsv @ 0x2] Current profile is unsupported\n' } : ok);

describe('levelsBackend', () => {
  it('is off without a word to ffmpeg when LEVELS_BACKEND=off', async () => {
    const spawn = fakeSpawn(ok);
    const logs: string[] = [];
    expect(await levelsBackend({ ...CONFIG, backend: 'off' }, { spawn, log: (m) => logs.push(m) })).toBeNull();
    expect(spawn.calls).toEqual([]);
    expect(logs).toEqual(['quality levels: off (LEVELS_BACKEND=off); only Original is offered']);
  });

  it('is off when there is no render node for qsv', async () => {
    const spawn = fakeSpawn(ok);
    const logs: string[] = [];
    expect(await levelsBackend({ ...CONFIG, backend: 'qsv' }, { spawn, exists: () => false, log: (m) => logs.push(m) })).toBeNull();
    expect(spawn.calls).toEqual([]);
    expect(logs).toEqual([`quality levels: off; no ${RENDER_NODE} for Quick Sync, so only Original is offered`]);
  });

  it('runs 1 s testsrc encodes with h264_qsv and hevc_qsv Main10 on the render node, and gives the qsv backend with FFMPEG_PATH and both codecs', async () => {
    const spawn = fakeSpawn(ok);
    const logs: string[] = [];
    const seen: string[] = [];
    const encoder = await levelsBackend({ ...CONFIG, backend: 'qsv' }, { spawn, exists: (p) => (seen.push(p), true), log: (m) => logs.push(m) });
    expect(seen).toEqual([RENDER_NODE]);
    expect(encoder?.backend.binary).toBe('/opt/ffmpeg/ffmpeg');
    expect(encoder?.backend.args).toBe(qsvBackend.args);
    expect([...encoder!.codecs]).toEqual(['h264', 'hevc']);
    expect(spawn.calls).toHaveLength(2);
    const [h264, hevc] = spawn.calls.map((c) => c.args.join(' '));
    for (const { binary, args } of spawn.calls) {
      expect(binary).toBe('/opt/ffmpeg/ffmpeg');
      expect(args.join(' ')).toContain(`-init_hw_device vaapi=va:${RENDER_NODE} -init_hw_device qsv=hw@va -filter_hw_device hw`);
      expect(args.join(' ')).toContain('-f lavfi -i testsrc=duration=1');
      expect(args.slice(-3)).toEqual(['-f', 'null', '-']);
    }
    expect(h264).toContain('-vf format=nv12,hwupload=extra_hw_frames=64 -c:v h264_qsv');
    expect(hevc).toContain('-vf format=p010le,hwupload=extra_hw_frames=64 -c:v hevc_qsv -profile:v main10');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^quality levels: qsv \(h264_qsv and hevc_qsv Main10 self-tests passed in \d+ ms\)$/);
  });

  it('offers only H.264 when the hevc_qsv self-test fails', async () => {
    const logs: string[] = [];
    const encoder = await levelsBackend({ ...CONFIG, backend: 'qsv' }, { spawn: fakeSpawn(hevcFails), exists: () => true, log: (m) => logs.push(m) });
    expect([...encoder!.codecs]).toEqual(['h264']);
    expect(logs).toEqual(['quality levels: qsv, H.264 only; the hevc_qsv Main10 self-test failed (exit 1: [hevc_qsv @ 0x2] Current profile is unsupported)']);
  });

  it('offers only HEVC when the h264_qsv self-test fails', async () => {
    const logs: string[] = [];
    const spawn = fakeSpawn((args) => (args.includes('h264_qsv') ? { code: 1, stderr: 'no\n' } : ok));
    const encoder = await levelsBackend({ ...CONFIG, backend: 'qsv' }, { spawn, exists: () => true, log: (m) => logs.push(m) });
    expect([...encoder!.codecs]).toEqual(['hevc']);
    expect(logs).toEqual(['quality levels: qsv, HEVC only; the h264_qsv self-test failed (exit 1: no)']);
  });

  it('is off when both qsv self-tests fail, with ffmpeg’s last lines in the log', async () => {
    const spawn = fakeSpawn({ code: 1, stderr: 'some noise\n[qsv @ 0x1] Error initializing an internal MFX session: unsupported (-3)\n' });
    const logs: string[] = [];
    expect(await levelsBackend({ ...CONFIG, backend: 'qsv' }, { spawn, exists: () => true, log: (m) => logs.push(m) })).toBeNull();
    expect(logs).toEqual([
      'quality levels: off; the h264_qsv self-test failed (exit 1: [qsv @ 0x1] Error initializing an internal MFX session: unsupported (-3)), and the hevc_qsv Main10 self-test failed (exit 1: [qsv @ 0x1] Error initializing an internal MFX session: unsupported (-3)), so only Original is offered',
    ]);
  });

  it('is off when the self-tests run past 10 s, and kills them', async () => {
    expect(SELF_TEST_TIMEOUT_MS).toBe(10_000);
    const spawn = fakeSpawn({ code: null });
    const logs: string[] = [];
    expect(await levelsBackend({ ...CONFIG, backend: 'qsv' }, { spawn, exists: () => true, log: (m) => logs.push(m), timeoutMs: 5 })).toBeNull();
    expect(spawn.killed).toBe(true);
    expect(logs).toEqual(['quality levels: off; the h264_qsv self-test failed (no answer in 10 s), and the hevc_qsv Main10 self-test failed (no answer in 10 s), so only Original is offered']);
  });

  it('is off when ffmpeg is missing', async () => {
    const logs: string[] = [];
    const encoder = await levelsBackend({ ffmpegPath: '/nonexistent/ffmpeg', backend: 'x264' }, { log: (m) => logs.push(m) });
    expect(encoder).toBeNull();
    expect(logs[0]).toMatch(/^quality levels: off; the libx264 self-test failed \(ffmpeg did not start: .*ENOENT.*\), so only Original is offered$/);
  });

  it('tests libx264 alone for LEVELS_BACKEND=x264, with no render node needed, and offers H.264 only', async () => {
    const spawn = fakeSpawn(ok);
    const logs: string[] = [];
    const encoder = await levelsBackend({ ...CONFIG, backend: 'x264' }, { spawn, exists: () => false, log: (m) => logs.push(m) });
    expect(encoder?.backend.binary).toBe('/opt/ffmpeg/ffmpeg');
    expect(encoder?.backend.args).toBe(x264Backend.args);
    expect([...encoder!.codecs]).toEqual(['h264']);
    expect(spawn.calls).toHaveLength(1);
    expect(spawn.calls[0]!.args.join(' ')).toContain('-c:v libx264');
    expect(logs[0]).toMatch(/^quality levels: x264, H.264 only \(libx264 self-test passed in \d+ ms\)$/);
  });

  const hasX264 = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout?.includes('libx264') ?? false;
  it.skipIf(!hasX264 && !process.env.CI)('passes the libx264 self-test with the real ffmpeg', async () => {
    const logs: string[] = [];
    expect(await levelsBackend({ ffmpegPath: 'ffmpeg', backend: 'x264' }, { log: (m) => logs.push(m) })).not.toBeNull();
    expect(logs[0]).toMatch(/self-test passed/);
  }, 15_000);
});
