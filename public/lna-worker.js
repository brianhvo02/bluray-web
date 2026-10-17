// Throwaway Local Network Access probe (device-test only): the worker half.
self.onmessage = async (e) => {
  const { url, variants } = e.data;
  const out = [];
  for (const v of variants) out.push(await probe(url, v));
  self.postMessage(out);
};

async function probe(url, v) {
  const t0 = performance.now();
  const r = { where: 'worker', variant: v.name };
  try {
    const res = await fetch(url, { headers: v.headers, cache: 'no-store' });
    const body = await res.text();
    Object.assign(r, { ok: res.ok, status: res.status, body: body.slice(0, 80), contentRange: res.headers.get('content-range') });
  } catch (err) {
    Object.assign(r, { ok: false, error: `${err && err.name}: ${err && err.message}` });
  }
  r.ms = Math.round(performance.now() - t0);
  const entries = performance.getEntriesByType('resource').filter((x) => x.name === url);
  const last = entries[entries.length - 1];
  if (last) r.timing = { start: Math.round(last.startTime), fetchStart: Math.round(last.fetchStart), responseEnd: Math.round(last.responseEnd), duration: Math.round(last.duration) };
  return r;
}
