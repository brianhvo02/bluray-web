/**
 * Buffer first (spec 2026-10-18-webrtc-people-design §7): whether a NAS disc can play straight through over this
 * connection, and if not, how long to wait and how many bytes to hold ahead first.
 */

/** The title's average rate is raised by this margin before it is compared with the connection. */
export const RATE_MARGIN = 1.1;
/** A wait shorter than this buffers silently (a progress ring, then play); a longer one asks first. */
export const SILENT_BELOW_S = 120;

export type BufferPlan =
  | { readonly kind: 'play' }
  | { readonly kind: 'silent'; readonly waitS: number; readonly bytes: number }
  | { readonly kind: 'ask'; readonly waitS: number; readonly bytes: number }
  | { readonly kind: 'too-big'; readonly canHoldBytes: number; readonly bytes: number };

export interface BufferPlanInput {
  /** The main playlist's length and the bytes of its clips. */
  readonly durationS: number;
  readonly playlistBytes: number;
  /** This connection's throughput (the pre-flight's probe). */
  readonly connectionMbps: number;
  /** The storage this device can still give the read-ahead cache. */
  readonly quotaBytes: number;
  /** SILENT_BELOW_S, except under the ?bufferask=1 test flag (0: every wait asks). */
  readonly silentBelowS?: number;
}

/**
 * Rate = playlist bytes ÷ duration × 1.1; wait = duration × (1 − connection ÷ rate); the bytes held ahead are the wait
 * times the connection's rate. A device that can't hold them can't wait them out.
 */
export function bufferPlan({ durationS, playlistBytes, connectionMbps, quotaBytes, silentBelowS = SILENT_BELOW_S }: BufferPlanInput): BufferPlan {
  if (!(durationS > 0) || !(playlistBytes > 0)) return { kind: 'play' };
  const rateMbps = ((playlistBytes * 8) / 1e6 / durationS) * RATE_MARGIN;
  if (connectionMbps >= rateMbps) return { kind: 'play' };
  const waitS = durationS * (1 - Math.max(connectionMbps, 0) / rateMbps);
  const bytes = (waitS * Math.max(connectionMbps, 0) * 1e6) / 8;
  if (bytes > quotaBytes) return { kind: 'too-big', canHoldBytes: quotaBytes, bytes };
  return waitS < silentBelowS ? { kind: 'silent', waitS, bytes } : { kind: 'ask', waitS, bytes };
}

/** "About {n} minutes before it can play straight through", the wait rounded up to a whole minute. */
export function waitCopy(waitS: number): string {
  return `About ${Math.ceil(waitS / 60)} minutes before it can play straight through`;
}

/** What the pre-flight says on a device that can't hold the wait (Review Focus 5). */
export function tooBigCopy(canHoldBytes: number, bytes: number): string {
  return `To play straight through, this device would need to hold ${formatGb(bytes)} ahead, and it has room for ${formatGb(canHoldBytes)}. It can play now, with pauses.`;
}

function formatGb(bytes: number): string {
  const gb = bytes / 1e9;
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

/** What storageRoom needs of `navigator.storage`. */
export interface StorageManagerLike {
  persist(): Promise<boolean>;
  estimate(): Promise<{ readonly quota?: number; readonly usage?: number }>;
}

/** The storage left for the cache: asks for persistence first (a refusal is fine), then the estimate's quota less usage. */
export async function storageRoom(storage: StorageManagerLike | undefined): Promise<number> {
  if (!storage) return 0;
  try {
    await storage.persist();
  } catch {
    // Persistence only keeps the browser from evicting the cache under pressure.
  }
  try {
    const { quota = 0, usage = 0 } = await storage.estimate();
    return Math.max(0, quota - usage);
  } catch {
    return 0;
  }
}

/** The main playlist's length (its play items', 45 kHz) and the bytes of its clips, each clip once. */
export function playlistFacts(
  playItems: readonly { readonly clipId: string; readonly inTime: number; readonly outTime: number }[],
  fileSizes: ReadonlyMap<string, number>,
): { durationS: number; playlistBytes: number } {
  const durationS = playItems.reduce((sum, p) => sum + Math.max(0, p.outTime - p.inTime), 0) / 45_000;
  const clips = new Set(playItems.map((p) => p.clipId));
  let playlistBytes = 0;
  for (const id of clips) playlistBytes += fileSizes.get(`BDMV/STREAM/${id}.M2TS`) ?? 0;
  return { durationS, playlistBytes };
}
