import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

describe('loadConfig', () => {
  it('reads roots, data dir and port', () => {
    expect(loadConfig({ LIBRARY_ROOTS: 'drv0=/library/drv0, drv2=/library/drv2', DATA_DIR: '/d', PORT: '4190' })).toEqual({
      roots: [
        { name: 'drv0', dir: '/library/drv0' },
        { name: 'drv2', dir: '/library/drv2' },
      ],
      dataDir: '/d',
      port: 4190,
    });
  });

  it('defaults to no roots, /data and port 8080 when unset', () => {
    expect(loadConfig({})).toEqual({ roots: [], dataDir: '/data', port: 8080 });
  });

  it.each(['drv0', '=/library/drv0', 'drv0=', 'drv0=/a,=/b'])('rejects the malformed LIBRARY_ROOTS %j', (value) => {
    expect(() => loadConfig({ LIBRARY_ROOTS: value })).toThrow(/LIBRARY_ROOTS entry ".*" is not name=dir/);
  });

  it('rejects duplicate root names', () => {
    expect(() => loadConfig({ LIBRARY_ROOTS: 'drv0=/a,drv0=/b' })).toThrow('LIBRARY_ROOTS names "drv0" twice');
  });

  it.each(['', 'abc', '80x', '-1', '1.5', '65536'])('rejects PORT=%j', (value) => {
    expect(() => loadConfig({ PORT: value })).toThrow(`PORT "${value}" is not a port number`);
  });
});
