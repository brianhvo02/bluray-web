export type DiscEntries = Array<[string, File]>;

const MAX_DEPTH = 6;

export function collectFromFileList(files: Iterable<File>): DiscEntries {
  return [...files].map((f) => [f.webkitRelativePath || f.name, f]);
}

export async function collectFromDirectoryHandle(handle: FileSystemDirectoryHandle, prefix = handle.name, depth = 0): Promise<DiscEntries> {
  if (depth > MAX_DEPTH) return [];
  const out: DiscEntries = [];
  for await (const [name, entry] of handle.entries()) {
    const path = `${prefix}/${name}`;
    if (entry.kind === 'file') out.push([path, await (entry as FileSystemFileHandle).getFile()]);
    else out.push(...(await collectFromDirectoryHandle(entry as FileSystemDirectoryHandle, path, depth + 1)));
  }
  return out;
}

/** Must be called synchronously from the drop handler: items become unusable after the event returns. */
export async function directoryFromDataTransfer(dt: DataTransfer): Promise<FileSystemDirectoryHandle | null> {
  const pending = Array.from(dt.items)
    .filter((item) => item.kind === 'file' && typeof item.getAsFileSystemHandle === 'function')
    .map((item) => item.getAsFileSystemHandle?.());
  for (const promise of pending) {
    const handle = await promise;
    if (handle && handle.kind === 'directory') return handle as FileSystemDirectoryHandle;
  }
  return null;
}
