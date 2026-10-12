export interface PresentableFrame {
  readonly timestamp: number;
  close(): void;
}

/** Holds decoded frames and picks the one to display for a clock time. Owns (and closes) every frame. */
export class VideoPresenter<F extends PresentableFrame> {
  presented = 0;
  dropped = 0;
  private queue: F[] = [];
  private shown: F | null = null;
  private presentedSinceClear = false;

  get size(): number {
    return this.queue.length;
  }

  get current(): F | null {
    return this.shown;
  }

  push(frame: F): void {
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1].timestamp > frame.timestamp) i--;
    this.queue.splice(i, 0, frame);
  }

  select(clockUs: number): F | null {
    let idx = this.lastDueIndex(clockUs);
    if (idx < 0) {
      if (this.presentedSinceClear || this.queue.length === 0) return null;
      idx = 0;
    }
    for (let i = 0; i < idx; i++) {
      this.queue[i].close();
      this.dropped++;
    }
    const next = this.queue[idx];
    this.queue = this.queue.slice(idx + 1);
    this.shown?.close();
    this.shown = next;
    this.presentedSinceClear = true;
    this.presented++;
    return next;
  }

  /** Closes due frames except the newest one, without presenting (used when rendering is throttled). */
  dropLate(clockUs: number): void {
    const idx = this.lastDueIndex(clockUs);
    if (idx <= 0) return;
    for (let i = 0; i < idx; i++) {
      this.queue[i].close();
      this.dropped++;
    }
    this.queue = this.queue.slice(idx);
  }

  clear(): void {
    for (const f of this.queue) f.close();
    this.queue = [];
    this.shown?.close();
    this.shown = null;
    this.presentedSinceClear = false;
  }

  private lastDueIndex(clockUs: number): number {
    let idx = -1;
    for (let i = 0; i < this.queue.length && this.queue[i].timestamp <= clockUs; i++) idx = i;
    return idx;
  }
}
