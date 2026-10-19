/**
 * An in-memory stand-in for the Origin Private File System: the part of FileSystemDirectoryHandle and
 * FileSystemFileHandle the read-ahead cache uses, with sync access handles that are exclusive like the browser's.
 */

export class MemoryFile {
  readonly kind = 'file';
  bytes = new Uint8Array(0);
  /** A sync access handle is open (the browser allows one per file). */
  locked = false;

  constructor(readonly name: string) {}

  async createSyncAccessHandle(): Promise<MemorySyncHandle> {
    if (this.locked) throw new DOMException(`${this.name} already has an open access handle`, 'NoModificationAllowedError');
    this.locked = true;
    return new MemorySyncHandle(this);
  }
}

export class MemorySyncHandle {
  private closed = false;

  constructor(private readonly file: MemoryFile) {}

  read(buffer: Uint8Array, opts: { at: number }): number {
    this.check();
    const src = this.file.bytes.subarray(opts.at, opts.at + buffer.length);
    buffer.set(src);
    return src.length;
  }

  write(buffer: Uint8Array, opts: { at: number }): number {
    this.check();
    const end = opts.at + buffer.length;
    if (end > this.file.bytes.length) {
      const grown = new Uint8Array(end);
      grown.set(this.file.bytes);
      this.file.bytes = grown;
    }
    this.file.bytes.set(buffer, opts.at);
    return buffer.length;
  }

  truncate(size: number): void {
    this.check();
    const out = new Uint8Array(size);
    out.set(this.file.bytes.subarray(0, size));
    this.file.bytes = out;
  }

  getSize(): number {
    this.check();
    return this.file.bytes.length;
  }

  flush(): void {
    this.check();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.file.locked = false;
  }

  private check(): void {
    if (this.closed) throw new DOMException('the access handle is closed', 'InvalidStateError');
  }
}

export class MemoryDirectory {
  readonly kind = 'directory';
  readonly entries = new Map<string, MemoryDirectory | MemoryFile>();

  constructor(readonly name = '') {}

  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<MemoryDirectory> {
    const found = this.entries.get(name);
    if (found instanceof MemoryDirectory) return found;
    if (found) throw new DOMException(`${name} is a file`, 'TypeMismatchError');
    if (!opts?.create) throw new DOMException(`${name} not found`, 'NotFoundError');
    const dir = new MemoryDirectory(name);
    this.entries.set(name, dir);
    return dir;
  }

  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<MemoryFile> {
    const found = this.entries.get(name);
    if (found instanceof MemoryFile) return found;
    if (found) throw new DOMException(`${name} is a directory`, 'TypeMismatchError');
    if (!opts?.create) throw new DOMException(`${name} not found`, 'NotFoundError');
    const file = new MemoryFile(name);
    this.entries.set(name, file);
    return file;
  }

  async removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void> {
    const found = this.entries.get(name);
    if (!found) throw new DOMException(`${name} not found`, 'NotFoundError');
    if (found instanceof MemoryDirectory && found.entries.size > 0 && !opts?.recursive) throw new DOMException(`${name} is not empty`, 'InvalidModificationError');
    if (locked(found)) throw new DOMException(`${name} is in use`, 'NoModificationAllowedError');
    this.entries.delete(name);
  }

  async *keys(): AsyncIterableIterator<string> {
    for (const name of [...this.entries.keys()]) yield name;
  }

  /** As the browser's handle, for code that takes one. */
  asHandle(): FileSystemDirectoryHandle {
    return this as unknown as FileSystemDirectoryHandle;
  }
}

function locked(entry: MemoryDirectory | MemoryFile): boolean {
  if (entry instanceof MemoryFile) return entry.locked;
  for (const child of entry.entries.values()) if (locked(child)) return true;
  return false;
}
