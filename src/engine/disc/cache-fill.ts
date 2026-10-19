/*
 * Original code for bluray-web: filling a NAS disc's read-ahead cache ahead of the play position (buffer first).
 *
 * Copyright (C) 2026  bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { ByteRange } from './read-ahead-cache';

/** Range requests the fill keeps in flight. */
export const FILL_IN_FLIGHT = 2;

/** Why a fill ended early: a read or a cache write failed, or there is no cache on this device. */
export type FillStop = 'failed' | 'no-cache';

export interface FillProgress {
  /** Bytes held ahead of the play position (the lead). */
  readonly bytes: number;
  /** The fill's target, or all there is ahead when that is less. */
  readonly targetBytes: number;
  /** The network's rate over the fill so far. */
  readonly mbps: number;
  readonly stopped?: FillStop;
}

export interface CacheFillDeps {
  readonly remote: {
    readonly chunkBytes: number;
    fillChunk(path: string, offset: number, signal: AbortSignal): Promise<number>;
    /** The chunk is being fetched already (by playback's reads or the fill). */
    isFetching(path: string, offset: number): boolean;
  };
  readonly cache: {
    coveredEnd(path: string, offset: number): number | null;
    heldBytes(path: string, start: number, end: number): number;
    evictOutside(keep: readonly ByteRange[]): Promise<void>;
  };
  /** The stream ranges still to play, from the play position on, in playback order. */
  ranges(): readonly ByteRange[];
  /**
   * Keep going to the end of the playlist, following the play position and freeing what it has passed, until stopped
   * (a bufferFirst open); otherwise stop once the target is held.
   */
  readonly follow: boolean;
  readonly targetBytes: number;
  progress(p: FillProgress): void;
  nowMs(): number;
}

interface Fetch {
  readonly path: string;
  readonly offset: number;
  readonly controller: AbortController;
}

/**
 * Fetches the playlist's bytes into the cache in playback order from the play position, FILL_IN_FLIGHT chunks at a
 * time, skipping what the cache holds or playback is fetching. Every time a chunk lands or the position moves (kick),
 * it looks again from the position: a seek abandons fetches that are no longer ahead and starts from the new place.
 */
export class CacheFill {
  /** The lead reached the target, or the fill ended. */
  readonly reached: Promise<void>;
  private resolveReached!: () => void;
  private wake: (() => void) | null = null;
  /** Something happened while the loop wasn't waiting: it looks again at once. */
  private woken = false;
  private stopped = false;
  private readonly inFlight = new Map<string, Fetch>();
  private failure = false;
  private networkBytes = 0;
  private last = '';

  constructor(private readonly deps: CacheFillDeps) {
    this.reached = new Promise((resolve) => (this.resolveReached = resolve));
  }

  /** The play position moved (a seek, or playback went on): look again. */
  kick(): void {
    this.poke();
  }

  private poke(): void {
    this.woken = true;
    this.wake?.();
  }

  /** Ends the fill; what the cache holds stays. */
  stop(): void {
    this.stopped = true;
    for (const f of this.inFlight.values()) f.controller.abort(new DOMException('the fill stopped', 'AbortError'));
    this.inFlight.clear();
    this.poke();
    this.resolveReached();
  }

  async run(): Promise<void> {
    const { remote, cache } = this.deps;
    const cb = remote.chunkBytes;
    const startedMs = this.deps.nowMs();
    try {
      while (!this.stopped) {
        this.woken = false;
        const ranges = this.deps.ranges();
        // a fetch no longer ahead (a seek) gives its place to one that is
        for (const [key, f] of this.inFlight) {
          if (ranges.some((r) => r.path === f.path && r.start <= f.offset && f.offset < r.end)) continue;
          f.controller.abort(new DOMException('no longer ahead', 'AbortError'));
          this.inFlight.delete(key);
        }
        if (this.deps.follow) await cache.evictOutside(ranges);
        const total = ranges.reduce((sum, r) => sum + r.end - r.start, 0);
        const targetBytes = Math.min(Math.max(0, this.deps.targetBytes), total);
        const bytes = ranges.reduce((sum, r) => sum + cache.heldBytes(r.path, r.start, r.end), 0);
        if (this.failure) {
          this.report({ bytes, targetBytes, mbps: this.mbps(startedMs), stopped: 'failed' });
          return;
        }
        this.report({ bytes, targetBytes, mbps: this.mbps(startedMs) });
        if (bytes >= targetBytes) {
          this.resolveReached();
          if (!this.deps.follow) return;
        }
        while (this.inFlight.size < FILL_IN_FLIGHT) {
          const next = this.nextMissing(ranges, cb);
          if (!next) break;
          this.start(next.path, next.offset);
        }
        if (this.inFlight.size === 0) {
          this.resolveReached(); // all there is ahead is held
          if (!this.deps.follow) return;
        }
        if (!this.woken) await new Promise<void>((resolve) => (this.wake = resolve));
        this.wake = null;
      }
    } finally {
      this.stop();
    }
  }

  private start(path: string, offset: number): void {
    const key = `${path}\n${offset}`;
    const f: Fetch = { path, offset, controller: new AbortController() };
    this.inFlight.set(key, f);
    this.deps.remote.fillChunk(path, offset, f.controller.signal).then(
      (n) => {
        this.networkBytes += n;
      },
      () => {
        if (!f.controller.signal.aborted) this.failure = true; // a read or a cache write failed (a full disk)
      },
    ).finally(() => {
      if (this.inFlight.get(key) === f) this.inFlight.delete(key);
      this.poke();
    });
  }

  /** The first chunk ahead that is neither held nor being fetched. */
  private nextMissing(ranges: readonly ByteRange[], cb: number): { path: string; offset: number } | null {
    for (const r of ranges) {
      let off = Math.floor(r.start / cb) * cb;
      while (off < r.end) {
        const chunkEnd = Math.min(off + cb, r.end);
        const covered = this.deps.cache.coveredEnd(r.path, off);
        if (covered !== null && covered >= chunkEnd) {
          off = Math.max(off + cb, Math.floor(covered / cb) * cb);
          continue;
        }
        if (this.inFlight.has(`${r.path}\n${off}`) || this.deps.remote.isFetching(r.path, off)) {
          off += cb;
          continue;
        }
        return { path: r.path, offset: off };
      }
    }
    return null;
  }

  private mbps(startedMs: number): number {
    return (this.networkBytes * 8) / 1e6 / (Math.max(this.deps.nowMs() - startedMs, 1) / 1000);
  }

  /** Progress, when the lead, the target or the outcome changed. */
  private report(p: FillProgress): void {
    const key = `${p.bytes}/${p.targetBytes}/${p.stopped ?? ''}`;
    if (key === this.last) return;
    this.last = key;
    this.deps.progress(p);
  }
}
