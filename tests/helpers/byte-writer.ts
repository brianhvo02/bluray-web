/** Big-endian byte/bit writer used by tests and the fixture script to build binary files. */
export class ByteWriter {
  private buf = new Uint8Array(256);
  private len = 0;
  private bitAcc = 0;
  private bitCount = 0;

  get position(): number {
    this.requireAligned();
    return this.len;
  }

  u8(v: number): this {
    this.requireAligned();
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
    return this;
  }

  u16(v: number): this {
    return this.u8(v >>> 8).u8(v);
  }

  u32(v: number): this {
    return this.u16(Math.floor(v / 0x10000) & 0xffff).u16(v & 0xffff);
  }

  ascii(s: string): this {
    for (const ch of s) this.u8(ch.charCodeAt(0));
    return this;
  }

  bytes(b: Uint8Array): this {
    this.requireAligned();
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
    return this;
  }

  zeros(n: number): this {
    return this.bytes(new Uint8Array(n));
  }

  /** Writes the low `n` bits of `v`, most significant first. */
  bits(n: number, v: number): this {
    for (let i = n - 1; i >= 0; i--) {
      const bit = Math.floor(v / 2 ** i) % 2;
      this.bitAcc = (this.bitAcc << 1) | bit;
      if (++this.bitCount === 8) {
        this.ensure(1);
        this.buf[this.len++] = this.bitAcc;
        this.bitAcc = 0;
        this.bitCount = 0;
      }
    }
    return this;
  }

  patchU16(at: number, v: number): this {
    this.buf[at] = (v >>> 8) & 0xff;
    this.buf[at + 1] = v & 0xff;
    return this;
  }

  patchU32(at: number, v: number): this {
    this.patchU16(at, Math.floor(v / 0x10000) & 0xffff);
    return this.patchU16(at + 2, v & 0xffff);
  }

  toBytes(): Uint8Array<ArrayBuffer> {
    this.requireAligned();
    return this.buf.slice(0, this.len);
  }

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  private requireAligned(): void {
    if (this.bitCount !== 0) throw new Error(`ByteWriter: ${this.bitCount} pending bits`);
  }
}
