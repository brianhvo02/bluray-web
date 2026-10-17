import { describe, expect, it } from 'vitest';
import { checkCapabilities } from './capabilities';

const base = { VideoDecoder: class {}, AudioWorkletNode: class {}, OffscreenCanvas: class {}, SharedArrayBuffer, crossOriginIsolated: true };

describe('checkCapabilities', () => {
  it('passes a fully capable Chromium-like environment', () => {
    const g = {
      ...base,
      showDirectoryPicker: () => undefined,
      document: { fullscreenEnabled: true },
      HTMLInputElement: class {},
      FileSystemHandle: class {
        queryPermission(): void {}
      },
      navigator: { audioSession: {}, wakeLock: {}, mediaSession: {} },
    };
    expect(checkCapabilities(g)).toEqual({
      core: { ok: true, missing: [] },
      canPickDirectory: true,
      canPickFolderInput: false,
      canRememberDiscs: true,
      fullscreen: 'standard',
      audioSession: true,
      wakeLock: true,
      mediaSession: true,
    });
  });

  it('names each missing capability', () => {
    const report = checkCapabilities({ OffscreenCanvas: class {}, crossOriginIsolated: false });
    expect(report.core.ok).toBe(false);
    expect(report.core.missing).toEqual(['WebCodecs video decoding', 'AudioWorklet', 'cross-origin isolation (SharedArrayBuffer)']);
    expect(report.canPickDirectory).toBe(false);
    expect(report.fullscreen).toBeNull();
  });

  it('reports a Firefox-Android-like global without VideoDecoder', () => {
    const { VideoDecoder: _v, ...g } = base;
    void _v;
    const report = checkCapabilities(g);
    expect(report.core.ok).toBe(false);
    expect(report.core.missing).toContain('WebCodecs video decoding');
  });

  it('reports a Safari-like global', () => {
    const g = {
      ...base,
      document: { webkitFullscreenEnabled: true },
      HTMLInputElement: { prototype: { webkitdirectory: false } },
      navigator: { mediaSession: {} },
    };
    const report = checkCapabilities(g);
    expect(report.core.ok).toBe(true);
    expect(report.canPickDirectory).toBe(false);
    expect(report.canPickFolderInput).toBe(true);
    expect(report.canRememberDiscs).toBe(false);
    expect(report.fullscreen).toBe('webkit');
    expect(report.mediaSession).toBe(true);
    expect(report.wakeLock).toBe(false);
  });

  it('reports no fullscreen when the document disables it (iPhone)', () => {
    const report = checkCapabilities({ ...base, document: { fullscreenEnabled: false, webkitFullscreenEnabled: false } });
    expect(report.fullscreen).toBeNull();
  });
});
