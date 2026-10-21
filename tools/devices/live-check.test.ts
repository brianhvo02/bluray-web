import { describe, expect, it } from 'vitest';
import { checkOrigin, countOf, libraryPath, parseLiveArgs, parseMap, parseOwnerCode, parseRoots, storeHashes, UNCONFIRMED } from './live-check';

const COMPOSE = `
    environment:
      LIBRARY_ROOTS: drv0=/library-mnt/drv0/BDMVs,drv0-dl=/library-mnt/drv0/Downloads@Downloads,drv2-rips=/library-mnt/drv2/Rips@Rips
    volumes:
      - type: bind
        source: /mnt/drv0
        target: /library-mnt/drv0
        read_only: true
      - type: bind
        source: /mnt/drv2
        target: /library-mnt/drv2
`;

describe('live-check', () => {
  it('maps a host path to the library path of the root that holds it', () => {
    const roots = parseRoots(COMPOSE);
    expect(roots).toEqual([
      { name: 'drv0', hostDir: '/mnt/drv0/BDMVs' },
      { name: 'drv0-dl', hostDir: '/mnt/drv0/Downloads' },
      { name: 'drv2-rips', hostDir: '/mnt/drv2/Rips' },
    ]);
    expect(libraryPath('/mnt/drv0/BDMVs/Some Disc', roots)).toBe('drv0/Some Disc');
    expect(libraryPath('/mnt/drv0/Downloads/A Set/DISC1', roots)).toBe('drv0-dl/A Set/DISC1');
    expect(libraryPath('/mnt/drv9/BDMVs/Elsewhere', roots)).toBeNull();
    expect(libraryPath('/mnt/drv0/BDMVsX/Not a root', roots)).toBeNull();
  });

  it('reads map.tsv', () => {
    expect(parseMap('id\tbdj\tfingerprint\tpath\nabc\t1\tf\t/mnt/drv0/BDMVs/X\n\n').get('abc')).toBe('/mnt/drv0/BDMVs/X');
  });

  it('reads the owner tooling output', () => {
    const out = 'Owner pairing code: ABCD-EFGH\nPairing link: https://x/?pair=ABCD-EFGH\nExpires: …\nPerson: Mika (test)\n\n▀▀\nRendezvous: registered\n';
    expect(parseOwnerCode(out)).toEqual({ code: 'ABCD-EFGH', person: 'Mika (test)', rendezvous: true });
    expect(() => parseOwnerCode('nothing')).toThrow();
  });

  it('runs on a preview origin only', () => {
    expect(checkOrigin('https://spec-x.bluray-web.pages.dev')).toBe('https://spec-x.bluray-web.pages.dev');
    expect(checkOrigin('https://spec-x.bluray-web.pages.dev/')).toBe('https://spec-x.bluray-web.pages.dev');
    expect(() => checkOrigin('https://bluray-web.pages.dev')).toThrow(/live site/);
    expect(() => checkOrigin('https://example.com')).toThrow();
    expect(() => checkOrigin('https://spec-x.bluray-web.pages.dev/app')).toThrow();
  });

  it('keeps results out of the repository and safaridriver off the stand-in ports', () => {
    const base = ['--origin', 'https://spec-x.bluray-web.pages.dev'];
    expect(() => parseLiveArgs([...base, '--out', 'tools/devices/out'])).toThrow(/outside the repository/);
    expect(() => parseLiveArgs([...base, '--out', '/tmp/lc', '--wd-ports', '4191,4211'])).toThrow(/4191/);
    expect(() => parseLiveArgs([...base, '--out', '/tmp/lc', '--wd-ports', '4100,4211'])).toThrow();
    const o = parseLiveArgs([...base, '--out', '/tmp/lc', '--mika-phone', 'sim:iPhone 17', '--library']);
    expect(o.discs).toEqual([...UNCONFIRMED]);
    expect(o.discs).toHaveLength(14);
    expect(o.wdPorts).toEqual([4211, 4212]);
    expect(() => parseLiveArgs([...base, '--out', '/tmp/lc', '--mika-phone', 'iphone'])).toThrow(/unknown target/);
  });

  it('reads the count from the plane hash', () => {
    const hashes = storeHashes();
    expect(new Set(hashes).size).toBe(3);
    expect(countOf(hashes[1]!, hashes)).toBe(1);
    expect(countOf('nope', hashes)).toBeNull();
    expect(countOf(null, hashes)).toBeNull();
  });
});
