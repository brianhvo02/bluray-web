import { describe, expect, it } from 'vitest';
import { detectVideoCaps, type VideoCapsEnv } from './video-caps';

function env(over: Partial<VideoCapsEnv> = {}): VideoCapsEnv {
  return {
    isConfigSupported: async () => ({ supported: true }),
    matchMedia: () => ({ matches: false }),
    screen: { width: 1920, height: 1080 },
    memoryProfile: 'desktop',
    ...over,
  };
}

describe('detectVideoCaps', () => {
  it('detects HEVC and Main10 separately', async () => {
    const seen: string[] = [];
    const caps = await detectVideoCaps(env({
      isConfigSupported: async (c) => {
        seen.push(`${c.codec}@${c.codedWidth}x${c.codedHeight}`);
        return { supported: c.codec === 'hvc1.1.6.L120.90' };
      },
    }));
    expect(caps.hevc).toBe(true);
    expect(caps.hevc10).toBe(false);
    expect(seen).toContain('hvc1.1.6.L120.90@1920x1080');
    expect(seen).toContain('hvc1.2.4.L120.90@1920x1080');
  });

  it('no VideoDecoder means no HEVC', async () => {
    const caps = await detectVideoCaps(env({ isConfigSupported: undefined }));
    expect(caps.hevc).toBe(false);
    expect(caps.hevc10).toBe(false);
  });

  it('a rejected probe means unsupported', async () => {
    const caps = await detectVideoCaps(env({ isConfigSupported: async () => { throw new Error('nope'); } }));
    expect(caps.hevc).toBe(false);
    expect(caps.hevc10).toBe(false);
  });

  it('HDR display from dynamic-range: high', async () => {
    const asked: string[] = [];
    const caps = await detectVideoCaps(env({ matchMedia: (q) => { asked.push(q); return { matches: q === '(dynamic-range: high)' }; } }));
    expect(caps.hdrDisplay).toBe(true);
    expect(asked).toContain('(dynamic-range: high)');
    expect((await detectVideoCaps(env())).hdrDisplay).toBe(false);
  });

  it('phone when constrained or when the shorter screen side is 900 or less', async () => {
    expect((await detectVideoCaps(env())).phone).toBe(false);
    expect((await detectVideoCaps(env({ screen: { width: 2560, height: 1600 } }))).phone).toBe(false);
    expect((await detectVideoCaps(env({ screen: { width: 390, height: 844 } }))).phone).toBe(true);
    expect((await detectVideoCaps(env({ memoryProfile: 'constrained', screen: { width: 2732, height: 2048 } }))).phone).toBe(true);
  });
});
