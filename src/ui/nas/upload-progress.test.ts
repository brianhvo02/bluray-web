import { describe, expect, it } from 'vitest';
import { countingBody, xhrSend, type XhrConstructor } from './upload-progress';

/** Just enough of XMLHttpRequest: the test drives its events. */
class FakeXhr {
  static last: FakeXhr | null = null;
  method = '';
  url = '';
  responseType = '';
  headers: [string, string][] = [];
  body: unknown = undefined;
  status = 0;
  statusText = '';
  response: ArrayBuffer | null = null;
  responseHeaders = '';
  aborted = false;
  upload: { onprogress: ((e: { loaded: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string): void {
    this.headers.push([name, value]);
  }
  send(body: unknown): void {
    this.body = body;
  }
  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }
  getAllResponseHeaders(): string {
    return this.responseHeaders;
  }
  answer(status: number, body: string | null, headers = ''): void {
    this.status = status;
    this.response = body === null ? null : (new TextEncoder().encode(body).buffer as ArrayBuffer);
    this.responseHeaders = headers;
    this.onload?.();
  }
}
const send = xhrSend(FakeXhr as unknown as XhrConstructor);

describe('xhrSend', () => {
  it('sends the body with its headers, tells the bytes sent and answers a Response', async () => {
    const file = new File(['abcdef'], 'a.srt');
    const sent: number[] = [];
    const res = send('https://nas.example/api/x', { method: 'PUT', body: file, headers: { Authorization: 'Bearer t' } }, (n) => sent.push(n));
    const xhr = FakeXhr.last!;
    expect([xhr.method, xhr.url, xhr.body, xhr.responseType]).toEqual(['PUT', 'https://nas.example/api/x', file, 'arraybuffer']);
    expect(xhr.headers).toEqual([['authorization', 'Bearer t']]);
    xhr.upload.onprogress!({ loaded: 2 });
    xhr.upload.onprogress!({ loaded: 6 });
    xhr.answer(413, '{"error":"too-large"}', 'content-type: application/json\r\nconnection: close\r\n');
    const answered = await res;
    expect(sent).toEqual([2, 6]);
    expect(answered.status).toBe(413);
    expect(answered.headers.get('content-type')).toBe('application/json');
    expect(await answered.json()).toEqual({ error: 'too-large' });
  });

  it('answers a 204 with no body', async () => {
    const res = send('https://nas.example/api/x', { method: 'PUT', body: new Blob(['a']) }, () => {});
    FakeXhr.last!.answer(204, '');
    expect((await res).body).toBeNull();
  });

  it('fails a network error as a TypeError, as fetch does', async () => {
    const res = send('https://nas.example/api/x', { method: 'PUT', body: new Blob(['a']) }, () => {});
    FakeXhr.last!.onerror!();
    await expect(res).rejects.toBeInstanceOf(TypeError);
  });

  it("aborts through the init's signal with its reason", async () => {
    const abort = new AbortController();
    const res = send('https://nas.example/api/x', { method: 'PUT', body: new Blob(['a']), signal: abort.signal }, () => {});
    abort.abort(new Error('stop'));
    expect(FakeXhr.last!.aborted).toBe(true);
    await expect(res).rejects.toThrow('stop');
    const early = new AbortController();
    early.abort(new Error('before'));
    await expect(send('https://nas.example/api/x', { method: 'PUT', signal: early.signal }, () => {})).rejects.toThrow('before');
  });
});

describe('countingBody', () => {
  it('tells the bytes read so far and yields the blob unchanged', async () => {
    const bytes = new Uint8Array(200_000).map((_, i) => i % 251);
    const sent: number[] = [];
    const out = new Uint8Array(await new Response(countingBody(new Blob([bytes]), (n) => sent.push(n))).arrayBuffer());
    expect(out).toEqual(bytes);
    expect(sent.at(-1)).toBe(bytes.byteLength);
    expect(sent).toEqual([...sent].sort((a, b) => a - b));
  });
});
