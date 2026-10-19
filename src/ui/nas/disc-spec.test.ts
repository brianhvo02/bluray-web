import { describe, expect, it, vi } from 'vitest';
import { portFetch } from '../../engine/disc/port-fetch';
import { nasDiscSpec } from './disc-spec';

const manifest = { discId: 'd1', name: 'Disc', files: [], inline: {} };

describe('nasDiscSpec', () => {
  it('gives an HTTPS disc no fetch port: the engine fetches it itself', () => {
    const discFetch = vi.fn<typeof fetch>();
    const { spec, release } = nasDiscSpec('https://nas.example/bluray/api/discs/d1/', 't', manifest, discFetch);
    expect(spec).toEqual({ kind: 'remote', base: 'https://nas.example/bluray/api/discs/d1/', token: 't', manifest });
    release();
  });

  it("answers a WebRTC disc's port with discFetch until released", async () => {
    const discFetch = vi.fn<typeof fetch>(async (input) => new Response(`read ${String(input)}`, { status: 206 }));
    const { spec, release } = nasDiscSpec('rtc://n/api/discs/d1/', 't', manifest, discFetch);
    expect(spec).toMatchObject({ kind: 'remote', base: 'rtc://n/api/discs/d1/', token: 't', manifest });
    expect(spec.fetchPort).toBeInstanceOf(MessagePort);
    const engineFetch = portFetch(spec.fetchPort!);
    const res = await engineFetch('rtc://n/api/discs/d1/files/BDMV/index.bdmv?t=t', { headers: { Range: 'bytes=0-3' } });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe('read rtc://n/api/discs/d1/files/BDMV/index.bdmv?t=t');
    expect(new Headers(discFetch.mock.calls[0]![1]!.headers).get('Range')).toBe('bytes=0-3');
    release();
    spec.fetchPort!.close();
  });
});
