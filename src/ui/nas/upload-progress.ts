/**
 * Uploads that report their progress. fetch can't tell how much of a request body has gone, and Safari can't stream
 * one, so over HTTPS the body goes through XMLHttpRequest, whose upload events say how much has been sent. Over WebRTC
 * the body is read as it goes out on the channel, so counting what was read is the progress.
 */

/** A fetch that also reports the request body's bytes sent so far. */
export type SendWithProgress = (url: string, init: RequestInit, onSent: (bytes: number) => void) => Promise<Response>;

/** Statuses whose Response must have a null body. */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/** The XMLHttpRequest constructor `xhrSend` needs; the global one in a browser. */
export type XhrConstructor = new () => XMLHttpRequest;

/**
 * A SendWithProgress over XMLHttpRequest: the body is a Blob (what a PUT of a file sends), the headers are set as given,
 * the init's signal aborts it (rejecting with the signal's reason), and a network failure rejects with a TypeError, as
 * fetch would, so callers treat both alike.
 */
export function xhrSend(Xhr: XhrConstructor): SendWithProgress {
  return (url, init, onSent) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init.signal ?? null;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const xhr = new Xhr();
      xhr.open(init.method ?? 'GET', url);
      xhr.responseType = 'arraybuffer';
      new Headers(init.headers).forEach((value, name) => xhr.setRequestHeader(name, value));
      const onAbort = (): void => xhr.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const done = (): void => signal?.removeEventListener('abort', onAbort);
      xhr.upload.onprogress = (e) => onSent(e.loaded);
      xhr.onload = () => {
        done();
        const headers = new Headers();
        for (const line of xhr.getAllResponseHeaders().trim().split(/[\r\n]+/)) {
          const at = line.indexOf(':');
          if (at > 0) headers.append(line.slice(0, at).trim(), line.slice(at + 1).trim());
        }
        resolve(new Response(NULL_BODY.has(xhr.status) ? null : (xhr.response as ArrayBuffer | null), { status: xhr.status, statusText: xhr.statusText, headers }));
      };
      xhr.onerror = () => {
        done();
        reject(new TypeError('Failed to fetch'));
      };
      xhr.onabort = () => {
        done();
        reject(signal?.reason ?? new DOMException('The upload was aborted.', 'AbortError'));
      };
      xhr.send(init.body as XMLHttpRequestBodyInit | null | undefined);
    });
}

/** `blob` as a stream that tells `onSent` the bytes read so far: what the WebRTC route has taken of the body. */
export function countingBody(blob: Blob, onSent: (bytes: number) => void): ReadableStream<Uint8Array> {
  const reader = blob.stream().getReader();
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      sent += value.byteLength;
      onSent(sent);
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
}
