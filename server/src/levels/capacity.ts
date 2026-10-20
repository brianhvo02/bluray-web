/** A viewing needs its film's output frame rate times this, for a margin (spec §6.4). */
export const NEED_MARGIN = 1.3;
/** A lease no read has touched for this long is gone (spec §6.4). */
export const LEASE_IDLE_MS = 120_000;

export type EncoderCodec = 'h264' | 'hevc';

export interface Lease {
  readonly viewingId: string;
  readonly codec: EncoderCodec;
  /** Encoder frames per second the viewing needs: its film's fps × 1.3. */
  readonly needFps: number;
}

/**
 * The GPU's encoder capacity, leased per viewing (spec §6.4). The budgets are what the GPU encodes per second of one
 * codec alone (H.264 190 fps, HEVC 100 fps); both codecs run on the same GPU, so each lease takes its need's share of its
 * own codec's budget, and a lease is admitted while the shares add up to at most the whole GPU. First come, first served.
 * A lease is kept by `touch` and expires 2 min after the last one.
 */
export class Capacity {
  private readonly leases = new Map<string, Lease & { touchedAt: number }>();

  constructor(
    private readonly budgets: { readonly h264: number; readonly hevc: number },
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Leases capacity for a viewing whose film runs at `fps`; true when admitted. A viewing that holds a lease keeps it (and
   * it is touched). `replacing` names leases this one takes over (the same viewer's earlier level or audio): it is
   * admitted if it fits without them, and then they are released; if it doesn't fit, they stay.
   */
  lease(viewingId: string, codec: EncoderCodec, fps: number, replacing: readonly string[] = []): boolean {
    this.expire();
    const held = this.leases.get(viewingId);
    const needFps = fps * NEED_MARGIN;
    if (held && held.codec === codec && held.needFps === needFps) {
      held.touchedAt = this.now();
      return true;
    }
    const without = new Set([viewingId, ...replacing]);
    if (this.share(without) + needFps / this.budgets[codec] > 1 + 1e-9) return false;
    for (const id of without) this.leases.delete(id);
    this.leases.set(viewingId, { viewingId, codec, needFps, touchedAt: this.now() });
    return true;
  }

  /** Whether a new viewing of `codec` at `fps` would be admitted now. */
  fits(codec: EncoderCodec, fps: number): boolean {
    this.expire();
    return this.share(new Set()) + (fps * NEED_MARGIN) / this.budgets[codec] <= 1 + 1e-9;
  }

  has(viewingId: string): boolean {
    this.expire();
    return this.leases.has(viewingId);
  }

  touch(viewingId: string): void {
    this.expire();
    const held = this.leases.get(viewingId);
    if (held) held.touchedAt = this.now();
  }

  release(viewingId: string): void {
    this.leases.delete(viewingId);
  }

  /** What is leased: encoder fps per codec, and each viewing. */
  inUse(): { h264Fps: number; hevcFps: number; viewings: Lease[] } {
    this.expire();
    const viewings = [...this.leases.values()].map(({ viewingId, codec, needFps }) => ({ viewingId, codec, needFps }));
    const sum = (codec: EncoderCodec): number => viewings.reduce((n, v) => n + (v.codec === codec ? v.needFps : 0), 0);
    return { h264Fps: sum('h264'), hevcFps: sum('hevc'), viewings };
  }

  /** The GPU's share the leases take, leaving out `without`. */
  private share(without: ReadonlySet<string>): number {
    let share = 0;
    for (const l of this.leases.values()) if (!without.has(l.viewingId)) share += l.needFps / this.budgets[l.codec];
    return share;
  }

  private expire(): void {
    const now = this.now();
    for (const [id, l] of this.leases) if (now - l.touchedAt >= LEASE_IDLE_MS) this.leases.delete(id);
  }
}
