import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fontsIn7z, TooLargeArchive, unxz } from './archive';

const fixture = (name: string): Buffer => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url));

describe('archives', () => {
  it('unxz restores the track', async () => {
    const out = await unxz(fixture('track.ass.xz'), 1 << 20);
    expect(out.toString('utf8').startsWith('[Script Info]')).toBe(true);
  });

  it('unxz refuses past maxBytes', async () => {
    await expect(unxz(fixture('track.ass.xz'), 10)).rejects.toBeInstanceOf(TooLargeArchive);
    // the instance still works afterwards
    expect((await unxz(fixture('track.ass.xz'), 1 << 20)).length).toBeGreaterThan(10);
  });

  it('fontsIn7z lists only fonts', async () => {
    const fonts = await fontsIn7z(fixture('pack.7z'));
    expect(fonts.map((f) => f.name)).toEqual(['Default.ttf']);
    const original = readFileSync(new URL('../../../src/engine/ass/default-font.ttf', import.meta.url));
    expect(fonts[0]!.data.equals(original)).toBe(true);
  });

  it('fontsIn7z rejects a broken archive', async () => {
    const pack = fixture('pack.7z');
    await expect(fontsIn7z(pack.subarray(0, 100))).rejects.toThrow();
    expect((await fontsIn7z(pack)).length).toBe(1);
  });
});
