import { chooseMemoryProfile } from './memory-profile';

export interface VideoCaps {
  hevc: boolean;
  hevc10: boolean;
  hdrDisplay: boolean;
  phone: boolean;
}

export interface VideoCapsEnv {
  isConfigSupported?: (c: { codec: string; codedWidth: number; codedHeight: number }) => Promise<{ supported?: boolean }>;
  matchMedia: (q: string) => { matches: boolean };
  screen: { width: number; height: number };
  memoryProfile: 'desktop' | 'constrained';
}

const HEVC_MAIN = 'hvc1.1.6.L120.90';
const HEVC_MAIN10 = 'hvc1.2.4.L120.90';
const PHONE_SHORT_SIDE = 900;

async function probe(env: VideoCapsEnv, codec: string): Promise<boolean> {
  if (!env.isConfigSupported) return false;
  try {
    return (await env.isConfigSupported({ codec, codedWidth: 1920, codedHeight: 1080 })).supported === true;
  } catch {
    return false;
  }
}

export async function detectVideoCaps(env: VideoCapsEnv): Promise<VideoCaps> {
  const [hevc, hevc10] = await Promise.all([probe(env, HEVC_MAIN), probe(env, HEVC_MAIN10)]);
  return {
    hevc,
    hevc10,
    hdrDisplay: env.matchMedia('(dynamic-range: high)').matches,
    phone: env.memoryProfile === 'constrained' || Math.min(env.screen.width, env.screen.height) <= PHONE_SHORT_SIDE,
  };
}

export function browserVideoCapsEnv(): VideoCapsEnv {
  return {
    isConfigSupported: typeof VideoDecoder !== 'undefined' && typeof VideoDecoder.isConfigSupported === 'function'
      ? (c) => VideoDecoder.isConfigSupported(c)
      : undefined,
    matchMedia: (q) => window.matchMedia(q),
    screen: { width: window.screen.width, height: window.screen.height },
    memoryProfile: chooseMemoryProfile({
      search: location.search,
      coarsePointer: matchMedia('(pointer: coarse)').matches,
      maxTouchPoints: navigator.maxTouchPoints,
      platform: navigator.platform,
    }),
  };
}

let cached: Promise<VideoCaps> | null = null;

/** One probe per page. */
export function videoCaps(): Promise<VideoCaps> {
  cached ??= detectVideoCaps(browserVideoCapsEnv());
  return cached;
}
