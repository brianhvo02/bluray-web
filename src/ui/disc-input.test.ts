import { describe, expect, it } from 'vitest';
import { collectFromDirectoryHandle, collectFromFileList, discFromDataTransfer } from './disc-input';
import { normalizeDiscPaths } from '../engine/disc/paths';

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
    expect(await discFromDataTransfer(dt)).toEqual({ kind: 'handle', handle });
    const noHandles = { items: [{ kind: 'string' }] } as unknown as DataTransfer;
    expect(await discFromDataTransfer(noHandles)).toBeNull();
  });

  it('falls back to webkitGetAsEntry when items lack getAsFileSystemHandle', async () => {
    const idx = new File([], 'index.bdmv');
    const bdmv = {
      isFile: false,
      isDirectory: true,
      name: 'BDMV',
      createReader() {
        let done = false;
        return {
          readEntries(ok: (e: unknown[]) => void) {
            ok(done ? [] : [{ isFile: true, isDirectory: false, name: 'index.bdmv', file: (cb: (f: File) => void) => cb(idx) }]);
            done = true;
          },
        };
      },
    };
    const dt = { items: [{ kind: 'file', webkitGetAsEntry: () => bdmv }] } as unknown as DataTransfer;
    expect(await discFromDataTransfer(dt)).toEqual({ kind: 'entries', entries: [['BDMV/index.bdmv', idx]] });
  });

  it('keeps names and BDMV-rooted paths from a file list so the disc still normalizes', () => {
    const names = ['BDMV/index.bdmv', 'BDMV/PLAYLIST/00000.mpls', 'BDMV/CLIPINF/00001.clpi', 'BDMV/STREAM/00001.m2ts'];
    const entries = collectFromFileList(names.map((n) => file(n.split('/').pop()!, n)));
    expect(entries.map(([p]) => p)).toEqual(names);
    expect([...normalizeDiscPaths(entries).keys()]).toEqual(names.map((n) => n.toUpperCase()));
    const bare = file('index.bdmv');
    expect(collectFromFileList([bare])).toEqual([['index.bdmv', bare]]);
  });
});
