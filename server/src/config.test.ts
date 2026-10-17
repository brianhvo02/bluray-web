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
      nightlyScanAt: { hour: 4, minute: 0 },
      scanPauseMs: 10,
      publicBase: 'https://mediaserver.tailnet-8e55.ts.net/bluray/api/',
    });
  });

  it('defaults to no roots, /data and port 8080 when unset', () => {
    expect(loadConfig({})).toEqual({
      roots: [],
      dataDir: '/data',
      port: 8080,
      nightlyScanAt: { hour: 4, minute: 0 },
      scanPauseMs: 10,
      publicBase: 'https://mediaserver.tailnet-8e55.ts.net/bluray/api/',
    });
  });

  it.each(['drv0', '=/library/drv0', 'drv0=', 'drv0=/a,=/b'])('rejects the malformed LIBRARY_ROOTS %j', (value) => {
    expect(() => loadConfig({ LIBRARY_ROOTS: value })).toThrow(/LIBRARY_ROOTS entry ".*" is not name=dir/);
  });

  it('rejects duplicate root names', () => {
    expect(() => loadConfig({ LIBRARY_ROOTS: 'drv0=/a,drv0=/b' })).toThrow('LIBRARY_ROOTS names "drv0" twice');
  });

  it('reads NIGHTLY_SCAN_AT and SCAN_PAUSE_MS', () => {
    const c = loadConfig({ NIGHTLY_SCAN_AT: '3:30', SCAN_PAUSE_MS: '0' });
    expect(c.nightlyScanAt).toEqual({ hour: 3, minute: 30 });
    expect(c.scanPauseMs).toBe(0);
  });

  it.each(['', '24:00', '4', '04:60', 'ab:cd'])('rejects NIGHTLY_SCAN_AT=%j', (value) => {
    expect(() => loadConfig({ NIGHTLY_SCAN_AT: value })).toThrow(`NIGHTLY_SCAN_AT "${value}" is not HH:MM`);
  });

  it.each(['', '-1', '1.5', 'x'])('rejects SCAN_PAUSE_MS=%j', (value) => {
    expect(() => loadConfig({ SCAN_PAUSE_MS: value })).toThrow('is not a number of milliseconds');
  });

  it.each(['', 'abc', '80x', '-1', '1.5', '65536'])('rejects PORT=%j', (value) => {
    expect(() => loadConfig({ PORT: value })).toThrow(`PORT "${value}" is not a port number`);
  });

  it('reads PUBLIC_BASE', () => {
    expect(loadConfig({ PUBLIC_BASE: 'http://localhost:4190/api/' }).publicBase).toBe('http://localhost:4190/api/');
  });

  it.each(['', 'nas/api', 'ftp://nas/api/'])('rejects PUBLIC_BASE=%j', (value) => {
    expect(() => loadConfig({ PUBLIC_BASE: value })).toThrow(`PUBLIC_BASE "${value}" is not an http(s) URL`);
  });
});
