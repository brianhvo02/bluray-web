/** The ASS trace page: lays out (and later draws) a script with our port, in Chrome, as the libass harness does. */
import { readFontFile } from '../../../src/engine/ass/font-tables';
import { AssFonts, createFontFaceLoader } from '../../../src/engine/ass/fonts';
import { FrameBuilder } from '../../../src/engine/ass/frame';
import { createCanvasMeasurer } from '../../../src/engine/ass/measure';
import { parseAss } from '../../../src/engine/ass/parse';
import type { RenderSettings } from '../../../src/engine/ass/state';
import { frameToTrace } from '../../../src/engine/ass/trace';
import { formatTrace } from '../format';
import type { AssTracePage } from './types';

const bytesOf = async (url: string): Promise<Uint8Array> => new Uint8Array(await (await fetch(url)).arrayBuffer());

const page: AssTracePage = {
  async run(scriptUrl, fontUrls, times, _pixels, storage) {
    const track = parseAss(new TextDecoder().decode(await bytesOf(scriptUrl)));
    const defaultFont = await readFontFile('DejaVuSans.ttf', await bytesOf('/fixtures/ass/fonts/DejaVuSans.ttf'));
    const fonts = new AssFonts(createFontFaceLoader(document.fonts), defaultFont);
    // libass registers a script's [Fonts] before the fonts directory
    await fonts.add(track.fonts.map((f) => ({ name: f.name, bytes: f.bytes })));
    await fonts.add(await Promise.all(fontUrls.map(async (u) => ({ name: u.split('/').pop()!, bytes: await bytesOf(u) }))));
    const settings: RenderSettings = { frameWidth: 1920, frameHeight: 1080, storageWidth: storage?.[0] ?? 1920, storageHeight: storage?.[1] ?? 1080, fontScale: 1 };
    const measureCtx = new OffscreenCanvas(1, 1).getContext('2d')!;
    // first pass: resolve every face the frames use, so they are loaded before measuring
    const probe = new FrameBuilder(track, fonts, createCanvasMeasurer(measureCtx));
    for (const t of times) probe.build(t, settings);
    await fonts.ready();
    const builder = new FrameBuilder(track, fonts, createCanvasMeasurer(measureCtx));
    const events = times.flatMap((t) => frameToTrace(builder.build(t, settings), fonts));
    return { trace: formatTrace(events), frames: [], missingFamilies: [...fonts.missingFamilies()] };
  },
};

(window as unknown as { assTrace: AssTracePage }).assTrace = page;
