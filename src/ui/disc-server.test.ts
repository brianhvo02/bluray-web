import { describe, expect, it } from 'vitest';
import { listServerDiscs, serverLinkFromLocation } from './disc-server';

describe('serverLinkFromLocation', () => {
  it('reads ?disc=<url>&token= as one served disc', () => {
    const link = serverLinkFromLocation('https://192.168.1.5:8443/?disc=https%3A%2F%2F192.168.1.5%3A8443%2Fdiscs%2Fabc123&token=tok');
    expect(link).toEqual({ token: 'tok', disc: 'https://192.168.1.5:8443/discs/abc123', listUrl: 'https://192.168.1.5:8443/discs' });
  });

  it('reads ?token= alone as the disc list of the server the page came from', () => {
    expect(serverLinkFromLocation('https://192.168.1.5:8443/?token=tok')).toEqual({ token: 'tok', disc: null, listUrl: 'https://192.168.1.5:8443/discs' });
  });

  it('ignores pages without a token, and disc URLs that are not http(s) or not a disc', () => {
    expect(serverLinkFromLocation('https://app.example/')).toBeNull();
    expect(serverLinkFromLocation('https://app.example/?disc=https%3A%2F%2Fx%2Fdiscs%2Fa')).toBeNull();
    expect(serverLinkFromLocation('https://app.example/?disc=javascript%3Aalert(1)&token=t')).toBeNull();
    expect(serverLinkFromLocation('https://app.example/?disc=https%3A%2F%2Fx%2Fother&token=t')).toBeNull();
  });
});

describe('serverLinkFromLocation with sameOrigin', () => {
  it('accepts a disc on the page origin and refuses one elsewhere, so the token never leaves the server', () => {
    const page = 'https://192.168.1.5:8443/probe.html?token=tok&disc=';
    expect(serverLinkFromLocation(`${page}${encodeURIComponent('https://192.168.1.5:8443/discs/abc')}`, { sameOrigin: true })?.disc).toBe('https://192.168.1.5:8443/discs/abc');
    expect(serverLinkFromLocation(`${page}${encodeURIComponent('/discs/abc')}`, { sameOrigin: true })?.disc).toBe('https://192.168.1.5:8443/discs/abc');
    expect(serverLinkFromLocation(`${page}${encodeURIComponent('https://evil.example/discs/abc')}`, { sameOrigin: true })).toBeNull();
    expect(serverLinkFromLocation(`${page}${encodeURIComponent('http://192.168.1.5:8443/discs/abc')}`, { sameOrigin: true })).toBeNull();
    expect(serverLinkFromLocation(`${page}${encodeURIComponent('https://192.168.1.5:9000/discs/abc')}`, { sameOrigin: true })).toBeNull();
    // the player keeps cross-origin links (the Vite dev server opening a disc on the disc server)
    expect(serverLinkFromLocation(`${page}${encodeURIComponent('https://evil.example/discs/abc')}`)).not.toBeNull();
  });
});

describe('listServerDiscs', () => {
  it("lists the server's discs with their base URLs, sending the token", async () => {
    const asked: Array<[string, string | null]> = [];
    const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      asked.push([url, new Headers(init?.headers).get('authorization')]);
      return new Response(JSON.stringify([{ id: 'a1', name: 'Disc One' }, { id: 'b2', name: 'Disc Two' }]));
    };
    const discs = await listServerDiscs({ token: 'tok', disc: null, listUrl: 'https://h:8443/discs' }, fakeFetch);
    expect(asked).toEqual([['https://h:8443/discs', 'Bearer tok']]);
    expect(discs).toEqual([
      { name: 'Disc One', baseUrl: 'https://h:8443/discs/a1' },
      { name: 'Disc Two', baseUrl: 'https://h:8443/discs/b2' },
    ]);
  });

  it('names a linked disc from the list, keeping it when the list fails', async () => {
    const link = { token: 'tok', disc: 'https://h:8443/discs/b2', listUrl: 'https://h:8443/discs' };
    const ok = async (): Promise<Response> => new Response(JSON.stringify([{ id: 'a1', name: 'Disc One' }, { id: 'b2', name: 'Disc Two' }]));
    expect(await listServerDiscs(link, ok)).toEqual([{ name: 'Disc Two', baseUrl: 'https://h:8443/discs/b2' }]);
    const failing = async (): Promise<Response> => new Response('no', { status: 401 });
    expect(await listServerDiscs(link, failing)).toEqual([{ name: 'b2', baseUrl: 'https://h:8443/discs/b2' }]);
  });

  it('fails with the server status when the list is refused', async () => {
    const failing = async (): Promise<Response> => new Response('no', { status: 401 });
    await expect(listServerDiscs({ token: 'x', disc: null, listUrl: 'https://h/discs' }, failing)).rejects.toThrow(/401/);
  });
});
