import { describe, expect, it } from 'vitest';
import { checkCapabilities } from './capabilities';

describe('checkCapabilities', () => {
  it('passes a fully capable Chromium-like environment', () => {
    const g = { VideoDecoder: class {}, AudioWorkletNode: class {}, OffscreenCanvas: class {}, SharedArrayBuffer, crossOriginIsolated: true, showDirectoryPicker: () => undefined };
    expect(checkCapabilities(g)).toEqual({ ok: true, missing: [], canPickDirectory: true });
  });

  it('names each missing capability', () => {
    const report = checkCapabilities({ OffscreenCanvas: class {}, crossOriginIsolated: false });
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual(['WebCodecs video decoding', 'AudioWorklet', 'cross-origin isolation (SharedArrayBuffer)']);
    expect(report.canPickDirectory).toBe(false);
  });
});
