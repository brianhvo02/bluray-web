import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Blob stand-in that reads ranges straight from the file. Node's `fs.openAsBlob` reports sizes modulo
 * 2^32 (an 8 GB clip appears as 3.5 GB), and Blu-ray clips are routinely larger than 4 GiB.
 * FileSource only needs `size`, `slice()`, `arrayBuffer()` and `stream()`.
 */
export function fileBlob(path: string, start = 0, end = statSync(path).size): Blob {
  return {
    size: Math.max(0, end - start),
    slice: (from = 0, to?: number): Blob => fileBlob(path, start + from, Math.min(end, to === undefined ? end : start + to)),
    arrayBuffer: async (): Promise<ArrayBuffer> => {
      const buf = new Uint8Array(Math.max(0, end - start));
      const fd = openSync(path, 'r');
      try {
        readSync(fd, buf, 0, buf.length, start);
      } finally {
        closeSync(fd);
      }
      return buf.buffer;
    },
    stream: (): ReadableStream<Uint8Array> => {
      let at = start;
      return new ReadableStream<Uint8Array>({
        pull: (controller) => {
          if (at >= end) return controller.close();
          const buf = new Uint8Array(Math.min(1 << 20, end - at));
          const fd = openSync(path, 'r');
          try {
            readSync(fd, buf, 0, buf.length, at);
          } finally {
            closeSync(fd);
          }
          at += buf.length;
          controller.enqueue(buf);
        },
      });
    },
  } as unknown as Blob;
}

/** Every file under `dir` as [path relative to dir with "/" separators, blob]. */
export async function directoryEntries(dir: string): Promise<Array<[string, Blob]>> {
  const out: Array<[string, Blob]> = [];
  const walk = async (path: string): Promise<void> => {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) await walk(full);
      else out.push([relative(dir, full).split(sep).join('/'), fileBlob(full)]);
    }
  };
  await walk(dir);
  return out;
}
