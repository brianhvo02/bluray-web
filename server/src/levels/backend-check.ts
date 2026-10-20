import { existsSync } from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import type { LevelsConfig } from '../config';
import { qsvBackend, x264Backend, type EncoderBackend } from './encoder';

/** The GPU's render node, which compose passes into the container (spec §6.2). */
export const RENDER_NODE = '/dev/dri/renderD128';
/** How long the start-up self-test may take. */
export const SELF_TEST_TIMEOUT_MS = 10_000;

const HEAD = ['-hide_banner', '-nostats', '-loglevel', 'error'];
const TESTSRC = ['-f', 'lavfi', '-i', 'testsrc=duration=1:size=1280x720:rate=24'];
const NULL_OUT = ['-f', 'null', '-'];

/** One second of `testsrc` through the encoder, to nowhere. */
const SELF_TESTS: Readonly<Record<'qsv' | 'x264', { readonly encoder: string; readonly args: readonly string[]; readonly backend: EncoderBackend }>> = {
  qsv: {
    encoder: 'h264_qsv',
    args: [
      ...HEAD, '-init_hw_device', `vaapi=va:${RENDER_NODE}`, '-init_hw_device', 'qsv=hw@va', '-filter_hw_device', 'hw',
      ...TESTSRC, '-vf', 'format=nv12,hwupload=extra_hw_frames=64', '-c:v', 'h264_qsv', ...NULL_OUT,
    ],
    backend: qsvBackend,
  },
  x264: {
    encoder: 'libx264',
    args: [...HEAD, ...TESTSRC, '-c:v', 'libx264', '-preset', 'veryfast', ...NULL_OUT],
    backend: x264Backend,
  },
};

export interface BackendCheckDeps {
  readonly spawn?: typeof nodeSpawn;
  readonly exists?: (path: string) => boolean;
  readonly log?: (message: string) => void;
  /** Injectable for tests; the log still says 10 s. */
  readonly timeoutMs?: number;
}

/** Runs ffmpeg with `args`; null when it exits 0, else why not. */
function run(spawn: typeof nodeSpawn, binary: string, args: readonly string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (failure: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(failure);
    };
    let child: ReturnType<typeof nodeSpawn>;
    try {
      child = spawn(binary, [...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      resolve(`ffmpeg did not start: ${(err as Error).message}`);
      return;
    }
    const timer = setTimeout(() => {
      done(`no answer in ${SELF_TEST_TIMEOUT_MS / 1000} s`);
      child.kill('SIGKILL');
    }, timeoutMs);
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4096);
    });
    child.on('error', (err) => done(`ffmpeg did not start: ${err.message}`));
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0) return done(null);
      const last = stderr.trim().split('\n').pop()?.trim();
      done(`${code === null ? `signal ${signal}` : `exit ${code}`}${last ? `: ${last}` : ''}`);
    });
  });
}

/**
 * The encoder backend the quality levels use, or null for Original only (spec §6.2): `LEVELS_BACKEND=off`; `qsv` without
 * the render node; or a 1 s `testsrc` encode with the backend's encoder that fails or takes over 10 s. The backend runs
 * `FFMPEG_PATH`. Logs one line saying which.
 */
export async function levelsBackend(config: Pick<LevelsConfig, 'backend' | 'ffmpegPath'>, deps: BackendCheckDeps = {}): Promise<EncoderBackend | null> {
  const log = deps.log ?? console.log;
  if (config.backend === 'off') {
    log('quality levels: off (LEVELS_BACKEND=off); only Original is offered');
    return null;
  }
  if (config.backend === 'qsv' && !(deps.exists ?? existsSync)(RENDER_NODE)) {
    log(`quality levels: off; no ${RENDER_NODE} for Quick Sync, so only Original is offered`);
    return null;
  }
  const test = SELF_TESTS[config.backend];
  const started = Date.now();
  const failure = await run(deps.spawn ?? nodeSpawn, config.ffmpegPath, test.args, deps.timeoutMs ?? SELF_TEST_TIMEOUT_MS);
  if (failure !== null) {
    log(`quality levels: off; the ${test.encoder} self-test failed (${failure}), so only Original is offered`);
    return null;
  }
  log(`quality levels: ${config.backend} (${test.encoder} self-test passed in ${Date.now() - started} ms)`);
  return { ...test.backend, binary: config.ffmpegPath };
}
