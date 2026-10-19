/** A request body read with a size cap, shared by the Worker's routes. */

/** The largest request body the Worker reads. */
export const MAX_BODY_BYTES = 4_096;

/** The body's bytes, counted as they stream in; null once they pass `MAX_BODY_BYTES`. */
export async function boundedBody(request: Request): Promise<Uint8Array<ArrayBuffer> | null> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
}
