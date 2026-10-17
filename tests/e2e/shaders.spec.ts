import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import pixelmatch from 'pixelmatch';
import { decodePng } from '../ass-trace/png';
import { collectWindows, expectInSync, telemetry, type TelemetrySample } from './telemetry';
import { CHROME_ONLY } from './support';

test.skip(({ browserName, isMobile }) => browserName !== 'chromium' || isMobile, CHROME_ONLY);

// fixtures/synthetic/disc1: an 8 s 640×360 testsrc2 feature (playlist 00000). disc-subs: First Play turns on the English
// PG stream, whose caption shows at 1–3 s.
const DISC1 = 'fixtures/synthetic/disc1';
const SUBS_DISC = 'fixtures/synthetic/disc-subs';
const BASIC = 'fixtures/shaders/basic';
const ANIME4K = 'fixtures/shaders/anime4k';
const GPU = process.env.SHADERS_GPU === '1';
/** Keeps the control bar and notices out of canvas screenshots (paused players always show their controls). */
const HIDE_OVERLAYS = '.control-bar, .notices, .shader-report { visibility: hidden !important; }';

interface ShaderTelemetry extends TelemetrySample {
  shader: { set: string; passesRun: number; gpuMs: number | null } | null;
}

interface Picture {
  width: number;
  height: number;
  rgba: Uint8Array;
}

interface Payload {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

const shaderTelemetry = async (page: Page): Promise<ShaderTelemetry | null> => (await telemetry(page)) as ShaderTelemetry | null;

function glsl(dir: string, name: string): Payload {
  return { name, mimeType: 'text/plain', buffer: readFileSync(`${dir}/${name}`) };
}

function inputConf(lines: string[]): Payload {
  return { name: 'input.conf', mimeType: 'text/plain', buffer: Buffer.from(`${lines.join('\n')}\n`) };
}

/** An input.conf line that defines the set `name` from the given files. */
function setLine(key: string, name: string, files: string[]): string {
  return `${key} change-list glsl-shaders set "${files.map((f) => `~~/shaders/${f}`).join(':')}"; show-text "${name}"`;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  const missing = await page.evaluate(async () => {
    const source = `onmessage = () => {
      try {
        const gl = new OffscreenCanvas(64, 64).getContext('webgl2');
        if (!gl) return postMessage('no WebGL2 context in a worker');
        if (!gl.getExtension('EXT_color_buffer_float')) return postMessage('no EXT_color_buffer_float');
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, 64, 64);
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return postMessage('RGBA16F framebuffer incomplete');
        postMessage(null);
      } catch (e) {
        postMessage(String(e));
      }
    };`;
    const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
    try {
      return await new Promise<string | null>((resolve) => {
        worker.onmessage = (e) => resolve(e.data as string | null);
        worker.onerror = (e) => resolve(`probe worker failed: ${e.message}`);
        worker.postMessage(0);
      });
    } finally {
      worker.terminate();
    }
  });
  if (missing !== null) console.log(`shaders e2e skipped: ${missing}`);
  test.skip(missing !== null, `WebGL2 float render targets unavailable: ${missing}`);
});

async function openDisc1(page: Page): Promise<void> {
  await page.goto('/?telemetry=1');
  await page.getByTestId('folder-input').setInputFiles(DISC1);
  await page.getByTestId('playlist-00000').click();
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 15_000 });
}

async function openSubsDisc(page: Page): Promise<void> {
  await page.goto('/?telemetry=1');
  await page.getByTestId('folder-input').setInputFiles(SUBS_DISC);
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 15_000 });
}

/** Adds shader files (and input.conf) the way the menu's "Add files…" does, and waits for the add report. */
async function addShaders(page: Page, files: Payload[]): Promise<void> {
  await page.getByTestId('shader-add-files').setInputFiles(files);
  await expect(page.getByTestId('shader-report')).toContainText('Added');
}

/** Picks a set (null for Off) in the Shaders menu. */
async function chooseSet(page: Page, name: string | null): Promise<void> {
  await page.getByTestId('player').hover();
  await page.getByTestId('shader-menu').click();
  await page.getByTestId(name === null ? 'shader-set-off' : `shader-set-${name}`).click();
}

/** Waits until telemetry reports the last frame drawn shaded by `name` (null: unshaded). */
async function expectShaded(page: Page, name: string | null): Promise<void> {
  await expect.poll(async () => (await shaderTelemetry(page))?.shader?.set ?? null, { timeout: 15_000, intervals: [50] }).toBe(name);
}

async function pause(page: Page): Promise<void> {
  await expect.poll(async () => (await telemetry(page))?.clockUs ?? 0, { timeout: 10_000 }).toBeGreaterThan(500_000);
  await page.getByTestId('player').hover();
  await page.getByTestId('play-toggle').click();
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'paused');
}

/** Sets the seek bar as a user would by dragging it (see subtitles.spec.ts). */
async function seekTo(page: Page, us: number): Promise<void> {
  await page.getByTestId('seek').evaluate((el, value) => {
    const input = el as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, us);
}

async function canvasShot(page: Page): Promise<Picture> {
  const png = await page.getByTestId('video-canvas').screenshot({ style: HIDE_OVERLAYS, animations: 'disabled' });
  return decodePng(new Uint8Array(png));
}

/** Pixels that differ at pixelmatch threshold 0.1, as a fraction of the picture. */
function diffFraction(a: Picture, b: Picture): number {
  expect([b.width, b.height]).toEqual([a.width, a.height]);
  return pixelmatch(a.rgba, b.rgba, undefined, a.width, a.height, { threshold: 0.1 }) / (a.width * a.height);
}

function centre(p: Picture): [number, number, number] {
  const i = (Math.floor(p.height / 2) * p.width + Math.floor(p.width / 2)) * 4;
  return [p.rgba[i]!, p.rgba[i + 1]!, p.rgba[i + 2]!];
}

function expectInverted(shaded: Picture, off: Picture): void {
  const s = centre(shaded);
  const o = centre(off);
  for (let c = 0; c < 3; c++) expect(Math.abs(s[c]! - (255 - o[c]!)), `channel ${c}: shaded ${s} off ${o}`).toBeLessThanOrEqual(8);
}

test('pass-through matches Off', async ({ page }) => {
  await openDisc1(page);
  await addShaders(page, [glsl(BASIC, 'passthrough.glsl'), inputConf([setLine('CTRL+1', 'Passthrough', ['passthrough.glsl'])])]);
  await pause(page);
  const off = await canvasShot(page);
  await chooseSet(page, 'Passthrough');
  await expectShaded(page, 'Passthrough');
  const shaded = await canvasShot(page);
  expect(diffFraction(off, shaded)).toBeLessThan(0.005);
});

test('invert inverts', async ({ page }) => {
  await openDisc1(page);
  await addShaders(page, [glsl(BASIC, 'invert.glsl'), inputConf([setLine('CTRL+1', 'Invert', ['invert.glsl'])])]);
  await pause(page);
  const off = await canvasShot(page);
  await chooseSet(page, 'Invert');
  await expectShaded(page, 'Invert');
  expectInverted(await canvasShot(page), off);
});

test('subtitles stay unshaded', async ({ page }) => {
  await openSubsDisc(page);
  await addShaders(page, [glsl(BASIC, 'invert.glsl'), inputConf([setLine('CTRL+1', 'Invert', ['invert.glsl'])])]);
  await chooseSet(page, 'Invert');
  await expectShaded(page, 'Invert');
  await seekTo(page, 0); // from the start, so the 1 s display set is read again
  await expect.poll(async () => (await telemetry(page))?.clockUs ?? Infinity, { timeout: 5_000, intervals: [20] }).toBeLessThan(1_000_000);
  await expect.poll(async () => (await telemetry(page))?.clockUs ?? 0, { timeout: 10_000, intervals: [20] }).toBeGreaterThanOrEqual(1_900_000);
  await pause(page);
  await expect.poll(async () => ((await telemetry(page)) as unknown as { pg: { objectsShown: number } | null }).pg?.objectsShown ?? 0).toBeGreaterThan(0);
  const on = await canvasShot(page);
  await page.getByTestId('player').hover();
  await page.getByTestId('subtitle-menu').click();
  await page.getByTestId('subtitle-off').click();
  let off = on;
  await expect.poll(async () => diffFraction(on, (off = await canvasShot(page))), { timeout: 5_000 }).toBeGreaterThan(0);
  let differing = 0;
  let bright = 0;
  for (let i = 0; i < on.rgba.length; i += 4) {
    if (on.rgba[i] === off.rgba[i] && on.rgba[i + 1] === off.rgba[i + 1] && on.rgba[i + 2] === off.rgba[i + 2]) continue;
    differing++;
    if (0.299 * on.rgba[i]! + 0.587 * on.rgba[i + 1]! + 0.114 * on.rgba[i + 2]! > 200) bright++;
  }
  console.log(`subtitles stay unshaded: ${bright}/${differing} differing pixels bright`);
  expect(differing).toBeGreaterThan(0);
  expect(bright / differing).toBeGreaterThanOrEqual(0.9);
});

test('nearest-x2 and WHEN', async ({ page }) => {
  await openDisc1(page);
  await addShaders(page, [
    glsl(BASIC, 'nearest-x2.glsl'),
    glsl(BASIC, 'when-skip.glsl'),
    inputConf([setLine('CTRL+1', 'Doubled', ['nearest-x2.glsl', 'when-skip.glsl'])]),
  ]);
  await chooseSet(page, 'Doubled');
  await expectShaded(page, 'Doubled');
  await expect.poll(async () => (await shaderTelemetry(page))?.shader?.passesRun, { timeout: 5_000, intervals: [50] }).toBe(1);
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: viewport.width * 2, height: viewport.height * 2 });
  await expect.poll(async () => (await shaderTelemetry(page))?.shader?.passesRun, { timeout: 5_000, intervals: [50] }).toBe(2);
});

test('persists across a reload', async ({ page }) => {
  await openDisc1(page);
  await addShaders(page, [
    glsl(BASIC, 'invert.glsl'),
    inputConf(['CTRL+1 change-list glsl-shaders set "~~/shaders/invert.glsl"; show-text "Invert"']),
  ]);
  await chooseSet(page, 'Invert');
  await expectShaded(page, 'Invert');
  await page.reload();
  await openDisc1(page);
  await page.getByTestId('player').hover();
  await page.getByTestId('shader-menu').click();
  await expect(page.getByTestId('shader-set-Invert')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expectShaded(page, 'Invert');
  await pause(page);
  const shaded = await canvasShot(page);
  await chooseSet(page, null);
  await expectShaded(page, null);
  expectInverted(shaded, await canvasShot(page));
});

test('paused switch repaints', async ({ page }) => {
  await openDisc1(page);
  await addShaders(page, [glsl(BASIC, 'invert.glsl'), inputConf([setLine('CTRL+1', 'Invert', ['invert.glsl'])])]);
  await pause(page);
  const before = await canvasShot(page);
  await chooseSet(page, 'Invert');
  await expect.poll(async () => diffFraction(before, await canvasShot(page)), { timeout: 2_000, intervals: [100] }).toBeGreaterThan(0.5);
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'paused');
});

test('Manage dialog takes focus and gives it back to the Shaders button', async ({ page }) => {
  await openDisc1(page);
  await page.getByTestId('player').hover();
  await page.getByTestId('shader-menu').click();
  await page.getByTestId('shader-manage').click();
  const dialog = page.getByRole('dialog', { name: 'Manage shaders' });
  await expect(dialog).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('shader-menu')).toBeFocused();
  await page.getByTestId('player').hover();
  await page.getByTestId('shader-menu').click();
  await page.getByTestId('shader-manage').click();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('shader-menu')).toBeFocused();
});

test.describe('on a GPU', () => {
  test.skip(!GPU, 'set SHADERS_GPU=1 to run the Anime4K and sync tests');

  test('runs Anime4K Mode A (Fast)', async ({ page }) => {
    await openDisc1(page);
    const files = ['Clamp_Highlights', 'Restore_CNN_M', 'Restore_CNN_VL', 'Upscale_CNN_x2_M', 'Upscale_CNN_x2_S', 'Upscale_CNN_x2_VL', 'AutoDownscalePre_x2', 'AutoDownscalePre_x4'];
    await addShaders(page, files.map((f) => glsl(ANIME4K, `Anime4K_${f}.glsl`)));
    await chooseSet(page, 'Anime4K: Mode A (Fast)');
    await expectShaded(page, 'Anime4K: Mode A (Fast)');
    const first = (await shaderTelemetry(page))!;
    expect(first.shader!.passesRun).toBeGreaterThan(0);
    await page.waitForTimeout(3_000);
    const later = (await shaderTelemetry(page))!;
    expect(later.shader?.set).toBe('Anime4K: Mode A (Fast)');
    expect(later.framesPresented!).toBeGreaterThan(first.framesPresented!);
  });

  test('stays in sync with a pass-through shader', async ({ page }) => {
    await openDisc1(page);
    await addShaders(page, [glsl(BASIC, 'passthrough.glsl'), inputConf([setLine('CTRL+1', 'Passthrough', ['passthrough.glsl'])])]);
    await chooseSet(page, 'Passthrough');
    await expectShaded(page, 'Passthrough');
    const windows = await collectWindows(page, 7_000_000);
    expect(windows.length).toBeGreaterThan(3);
    for (const w of windows) expect(w.clockMode).toBe('audio'); // 'wall' means no running audio output
    expectInSync(windows);
  });
});
