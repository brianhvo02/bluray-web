/** Notes when a disc's file was last read, so background work can tell that someone is watching. */
export class DiscActivity {
  private last: number | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** A file range was read. */
  note(): void {
    this.last = this.now();
  }

  /** A read happened within the last `windowMs`. */
  busy(windowMs = 120_000): boolean {
    return this.last !== null && this.now() - this.last <= windowMs;
  }
}
