import { DiscError, type ByteSource } from './byte-source';

/** ByteSource over picked files. Blob.slice() reads only the requested range from disk. */
export class FileSource implements ByteSource {
  constructor(private readonly files: ReadonlyMap<string, Blob>) {}

  exists(path: string): boolean {
    return this.files.has(path.toUpperCase());
  }

  size(path: string): number {
    return this.get(path).size;
  }

  list(dir: string): string[] {
    const prefix = `${dir.toUpperCase().replace(/\/$/, '')}/`;
    const names: string[] = [];
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest !== '' && !rest.includes('/')) names.push(rest);
    }
    return names.sort();
  }

  async read(path: string, offset: number, length: number): Promise<Uint8Array> {
    if (!Number.isInteger(offset) || offset < 0) throw new RangeError(`invalid read offset ${offset} in ${path}`); // Blob.slice would count from the end
    const blob = this.get(path);
    const end = Math.min(offset + length, blob.size);
    if (offset >= end) return new Uint8Array(0);
    try {
      return new Uint8Array(await blob.slice(offset, end).arrayBuffer());
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotReadableError') {
        throw new DiscError('source-changed', 'The disc folder changed on disk. Please reopen it.', [path]);
      }
      throw new DiscError('read-failed', `Failed to read ${path}: ${String(err)}`, [path]);
    }
  }

  private get(path: string): Blob {
    const blob = this.files.get(path.toUpperCase());
    if (!blob) throw new DiscError('missing-file', `Missing file ${path}`, [path]);
    return blob;
  }
}
