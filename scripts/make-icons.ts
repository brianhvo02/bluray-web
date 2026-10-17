// Renders public/favicon.svg to the PNG app icons in public/icons/ with Playwright's Chrome.
// Run with `npx tsx scripts/make-icons.ts` after changing the favicon, and commit the output.
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const BACKGROUND = '#0b0b0d';

interface Icon {
  readonly file: string;
  readonly size: number;
  /** Share of the canvas the artwork spans. */
  readonly scale: number;
  /** Fill behind the artwork; transparent when absent. */
  readonly background?: string;
}

const ICONS: readonly Icon[] = [
  { file: 'icon-192.png', size: 192, scale: 1 },
  { file: 'icon-512.png', size: 512, scale: 1 },
  // Maskable: the artwork stays inside the central 80% safe zone, the background bleeds to the edges.
  { file: 'maskable-512.png', size: 512, scale: 0.8, background: BACKGROUND },
  // iOS draws transparent pixels black and rounds the corners itself.
  { file: 'apple-touch-icon.png', size: 180, scale: 0.86, background: BACKGROUND },
];

const svg = readFileSync(`${PUBLIC}favicon.svg`, 'utf8');
const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

mkdirSync(`${PUBLIC}icons`, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const icon of ICONS) {
    const page = await browser.newPage({ viewport: { width: icon.size, height: icon.size }, deviceScaleFactor: 1 });
    const art = Math.round(icon.size * icon.scale);
    await page.setContent(
      `<html><body style="margin:0;width:${icon.size}px;height:${icon.size}px;display:flex;align-items:center;justify-content:center;background:${icon.background ?? 'transparent'}">` +
        `<img src="${dataUrl}" width="${art}" height="${art}"></body></html>`,
    );
    await page.locator('img').evaluate((img: HTMLImageElement) => img.decode());
    await page.screenshot({ path: `${PUBLIC}icons/${icon.file}`, omitBackground: icon.background === undefined });
    await page.close();
  }
} finally {
  await browser.close();
}
