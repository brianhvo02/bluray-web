export interface CapabilityReport {
  readonly core: { readonly ok: boolean; readonly missing: readonly string[] };
  /** showDirectoryPicker */
  readonly canPickDirectory: boolean;
  /** webkitdirectory on a file input */
  readonly canPickFolderInput: boolean;
  /** FileSystemHandle permissions (recent discs) */
  readonly canRememberDiscs: boolean;
  readonly fullscreen: 'standard' | 'webkit' | null;
  readonly audioSession: boolean;
  readonly wakeLock: boolean;
  readonly mediaSession: boolean;
}

type Bag = Record<string, unknown>;

function obj(v: unknown): Bag | undefined {
  return (typeof v === 'object' || typeof v === 'function') && v !== null ? (v as Bag) : undefined;
}

export function checkCapabilities(g: Bag = globalThis as unknown as Bag): CapabilityReport {
  const missing: string[] = [];
  if (!('VideoDecoder' in g)) missing.push('WebCodecs video decoding');
  if (!('AudioWorkletNode' in g)) missing.push('AudioWorklet');
  if (!('OffscreenCanvas' in g)) missing.push('OffscreenCanvas');
  if (!('SharedArrayBuffer' in g) || g.crossOriginIsolated !== true) missing.push('cross-origin isolation (SharedArrayBuffer)');

  const doc = obj(g.document);
  const fullscreen = doc?.fullscreenEnabled === true ? 'standard' : doc?.webkitFullscreenEnabled === true ? 'webkit' : null;
  const inputProto = obj(obj(g.HTMLInputElement)?.prototype);
  const handleProto = obj(obj(g.FileSystemHandle)?.prototype);
  const nav = obj(g.navigator);

  return {
    core: { ok: missing.length === 0, missing },
    canPickDirectory: typeof g.showDirectoryPicker === 'function',
    canPickFolderInput: inputProto !== undefined && 'webkitdirectory' in inputProto,
    canRememberDiscs: handleProto !== undefined && 'queryPermission' in handleProto,
    fullscreen,
    audioSession: nav !== undefined && 'audioSession' in nav,
    wakeLock: nav !== undefined && 'wakeLock' in nav,
    mediaSession: nav !== undefined && 'mediaSession' in nav,
  };
}

/**
 * Whether the landing screen warns that Safari clears site data after 7 days without a visit: only in a browser tab of a
 * browser without FileSystemHandle permissions (non-Chromium). An installed app (standalone) is exempt.
 */
export function showStorageHint(
  canRememberDiscs: boolean,
  win: { matchMedia(query: string): { readonly matches: boolean } } = window,
): boolean {
  if (canRememberDiscs) return false;
  try {
    return !win.matchMedia('(display-mode: standalone)').matches;
  } catch {
    return true;
  }
}
