export interface CapabilityReport {
  readonly ok: boolean;
  readonly missing: readonly string[];
  readonly canPickDirectory: boolean;
}

export function checkCapabilities(g: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): CapabilityReport {
  const missing: string[] = [];
  if (!('VideoDecoder' in g)) missing.push('WebCodecs video decoding');
  if (!('AudioWorkletNode' in g)) missing.push('AudioWorklet');
  if (!('OffscreenCanvas' in g)) missing.push('OffscreenCanvas');
  if (!('SharedArrayBuffer' in g) || g.crossOriginIsolated !== true) missing.push('cross-origin isolation (SharedArrayBuffer)');
  return { ok: missing.length === 0, missing, canPickDirectory: typeof g.showDirectoryPicker === 'function' };
}
