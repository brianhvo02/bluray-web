export type MemoryProfileName = 'desktop' | 'constrained';

const MB = 1024 * 1024;

/** Memory limits that differ between desktop browsers and phones or tablets. */
export interface MemoryProfile {
  /** An IG sub-path clip larger than this is not preloaded. */
  readonly igPreloadLimitBytes: number;
  readonly assEventCacheBytes: number;
  readonly assLayerCacheBytes: number;
  readonly assMaskCacheBytes: number;
  /** Upper bound of the per-side supersampling of ASS text masks. */
  readonly maxTextSupersampling: number;
  /** Decoded frames held for the presenter, for a stream of this coded width. */
  readonly maxQueuedFrames: (codedWidth: number) => number;
  /** A NAS disc's read-ahead: bytes fetched ahead of playback and kept. */
  readonly remoteReadAheadBytes: number;
}

export const MEMORY_PROFILES: Readonly<Record<MemoryProfileName, MemoryProfile>> = {
  desktop: {
    igPreloadLimitBytes: 512 * MB,
    assEventCacheBytes: 128 * MB,
    assLayerCacheBytes: 128 * MB,
    assMaskCacheBytes: 64 * MB,
    maxTextSupersampling: 8,
    maxQueuedFrames: () => 8,
    remoteReadAheadBytes: 128 * MB,
  },
  constrained: {
    igPreloadLimitBytes: 64 * MB,
    assEventCacheBytes: 32 * MB,
    assLayerCacheBytes: 32 * MB,
    assMaskCacheBytes: 16 * MB,
    maxTextSupersampling: 4,
    maxQueuedFrames: (codedWidth) => (codedWidth >= 3840 ? 4 : 8),
    remoteReadAheadBytes: 48 * MB,
  },
};
