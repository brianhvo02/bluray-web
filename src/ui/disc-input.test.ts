import { describe, expect, it } from 'vitest';
import { collectFromDirectoryHandle, collectFromFileList, directoryFromDataTransfer } from './disc-input';

function file(name: string, relative = ''): File {
  const f = new File(['x'], name);
  Object.defineProperty(f, 'webkitRelativePath', { value: relative });
  return f;
}

function dir(name: string, children: Record<string, File | FileSystemDirectoryHandle>): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    name,
    async *entries() {
      for (const [childName, child] of Object.entries(children)) {
        if (child instanceof File) yield [childName, { kind: 'file', name: childName, getFile: async () => child }];
        else yield [childName, child];
      }
    },
  } as unknown as FileSystemDirectoryHandle;
}

describe('disc input', () => {
  it('uses webkitRelativePath from a folder <input>', () => {
    const a = file('index.bdmv', 'Movie/BDMV/index.bdmv');
    expect(collectFromFileList([a])).toEqual([['Movie/BDMV/index.bdmv', a]]);
  });

  it('walks a directory handle, prefixing the folder name', async () => {
    const idx = file('index.bdmv');
    const m2ts = file('00000.m2ts');
    const root = dir('Movie', { BDMV: dir('BDMV', { 'index.bdmv': idx, STREAM: dir('STREAM', { '00000.m2ts': m2ts }) }) });
    expect(await collectFromDirectoryHandle(root)).toEqual([
      ['Movie/BDMV/index.bdmv', idx],
      ['Movie/BDMV/STREAM/00000.m2ts', m2ts],
    ]);
  });

  it('finds a dropped directory handle', async () => {
    const handle = dir('Movie', {});
    const dt = { items: [{ kind: 'file', getAsFileSystemHandle: async () => handle }] } as unknown as DataTransfer;
    expect(await directoryFromDataTransfer(dt)).toBe(handle);
    const noHandles = { items: [{ kind: 'string' }] } as unknown as DataTransfer;
    expect(await directoryFromDataTransfer(noHandles)).toBeNull();
  });
});
