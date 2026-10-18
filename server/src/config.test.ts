import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

describe('loadConfig', () => {
  it('reads roots, data dir and port', () => {
    expect(loadConfig({ LIBRARY_ROOTS: 'drv0=/library/drv0, drv2=/library/drv2', DATA_DIR: '/d', PORT: '4192' })).toEqual({
      roots: [
        { name: 'drv0', dir: '/library/drv0' },
        { name: 'drv2', dir: '/library/drv2' },
      ],
      dataDir: '/d',
      port: 4192,
      nightlyScanAt: { hour: 4, minute: 0 },
      scanPauseMs: 10,
      publicBase: 'https://mediaserver.tailnet-8e55.ts.net/bluray/api/',
      trustedProxy: 'caddy',
      tmdbApiKey: null,
      titleLibrary: 'owners',
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
      trustedProxy: 'caddy',
      tmdbApiKey: null,
      titleLibrary: 'owners',
    });
  });

  it.each(['drv0', '=/library/drv0', 'drv0=', 'drv0=/a,=/b'])('rejects the malformed LIBRARY_ROOTS %j', (value) => {
    expect(() => loadConfig({ LIBRARY_ROOTS: value })).toThrow(/LIBRARY_ROOTS entry ".*" is not name=dir/);
  });

  it('rejects duplicate root names', () => {
    expect(() => loadConfig({ LIBRARY_ROOTS: 'drv0=/a,drv0=/b' })).toThrow('LIBRARY_ROOTS names "drv0" twice');
  });

  it('reads TMDB_API_KEY and TITLE_LIBRARY', () => {
    expect(loadConfig({ TMDB_API_KEY: 'k123', TITLE_LIBRARY: 'everyone' })).toMatchObject({ tmdbApiKey: 'k123', titleLibrary: 'everyone' });
    expect(loadConfig({ TMDB_API_KEY: '', TITLE_LIBRARY: 'owners' })).toMatchObject({ tmdbApiKey: null, titleLibrary: 'owners' });
    expect(() => loadConfig({ TITLE_LIBRARY: 'all' })).toThrow('TITLE_LIBRARY "all" is not owners or everyone');
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
    expect(loadConfig({ PUBLIC_BASE: 'http://localhost:4192/api/' }).publicBase).toBe('http://localhost:4192/api/');
  });

  it.each(['', 'nas/api', 'ftp://nas/api/'])('rejects PUBLIC_BASE=%j', (value) => {
    expect(() => loadConfig({ PUBLIC_BASE: value })).toThrow(`PUBLIC_BASE "${value}" is not an http(s) URL`);
  });

  it('reads TRUSTED_PROXY', () => {
    expect(loadConfig({ TRUSTED_PROXY: '172.18.0.2' }).trustedProxy).toBe('172.18.0.2');
  });

  it.each(['', 'a b', 'caddy,evil'])('rejects TRUSTED_PROXY=%j', (value) => {
    expect(() => loadConfig({ TRUSTED_PROXY: value })).toThrow(`TRUSTED_PROXY "${value}" is not an IP or hostname`);
  });

  it('reads RENDEZVOUS_URL, treating unset or empty as no rendezvous', () => {
    expect(loadConfig({ RENDEZVOUS_URL: 'https://bluray-rendezvous.example.workers.dev' }).rendezvousUrl).toBe(
      'https://bluray-rendezvous.example.workers.dev',
    );
    expect(loadConfig({}).rendezvousUrl).toBeUndefined();
    expect(loadConfig({ RENDEZVOUS_URL: '' }).rendezvousUrl).toBeUndefined();
  });

  it.each(['rendezvous', 'ftp://r.example/'])('rejects RENDEZVOUS_URL=%j', (value) => {
    expect(() => loadConfig({ RENDEZVOUS_URL: value })).toThrow(`RENDEZVOUS_URL "${value}" is not an http(s) URL`);
  });

  it('parses a root group written name=dir@group', () => {
    const { roots } = loadConfig({ LIBRARY_ROOTS: 'drv0=/a,drv0-dl=/b@Downloads' });
    expect(roots).toEqual([{ name: 'drv0', dir: '/a' }, { name: 'drv0-dl', dir: '/b', group: 'Downloads' }]);
  });

  it('rejects a group named like a root', () => {
    expect(() => loadConfig({ LIBRARY_ROOTS: 'drv0=/a,drv1=/b@drv0' })).toThrow('group "drv0" is also a root name');
  });
});
