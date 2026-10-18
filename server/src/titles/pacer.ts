import { SourceUnavailable } from './sources';

/** Thrown by a paced call that got a 429; `retryAfterMs` is from its Retry-After header. */
export class RateLimited extends Error {
  override name = 'RateLimited';
  constructor(readonly retryAfterMs: number | null) {
    super('rate limited');
  }
}

/**
 * Starts at most `perWindow` calls in any `windowMs` (a sliding window), in the order they were made.
 * A call that throws `RateLimited` holds every call back for its Retry-After (one window without one),
 * is retried once, and a second `RateLimited` becomes `SourceUnavailable`.
 */
export class Pacer {
  private readonly starts: number[] = [];
  private queue: Promise<void> = Promise.resolve();
  private blockedUntil = 0;

  constructor(
    private readonly perWindow: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.slot();
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof RateLimited)) throw e;
        if (attempt > 0) throw new SourceUnavailable('rate limited after a retry');
        this.blockedUntil = Math.max(this.blockedUntil, this.now() + (e.retryAfterMs ?? this.windowMs));
      }
    }
  }

  /** Waits for this call's turn, in order, then records its start. */
  private slot(): Promise<void> {
    const turn = this.queue.then(async () => {
      for (;;) {
        const t = this.now();
        while (this.starts.length > 0 && this.starts[0]! <= t - this.windowMs) this.starts.shift();
        const wait = Math.max(this.blockedUntil - t, this.starts.length >= this.perWindow ? this.starts[0]! + this.windowMs - t : 0);
        if (wait <= 0) break;
        await this.sleep(wait);
      }
      this.starts.push(this.now());
    });
    this.queue = turn;
    return turn;
  }
}
