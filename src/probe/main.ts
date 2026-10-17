import { runChecks, type ProbeEnv, type WorkerProbe } from './checks';

const root = document.getElementById('root') as HTMLElement;

function pickFolder(): Promise<File[]> {
  return new Promise((resolve) => {
    const button = document.createElement('button');
    button.textContent = 'Pick a disc folder';
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.setAttribute('webkitdirectory', '');
    input.hidden = true;
    input.addEventListener('change', () => {
      button.disabled = true;
      resolve([...(input.files ?? [])]);
    });
    button.addEventListener('click', () => input.click());
    root.append(button, input);
  });
}

function worker(entries: ReadonlyArray<readonly [string, File]>): Promise<WorkerProbe> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./probe-worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<WorkerProbe>) => {
      resolve(e.data);
      w.terminate();
    };
    const fail = (message: string) => (): void => {
      reject(new Error(message));
      w.terminate();
    };
    w.onerror = fail('worker failed');
    w.onmessageerror = fail('worker message failed');
    w.postMessage({ entries });
  });
}

const env: ProbeEnv = {
  pickFolder,
  createAudioContext: () => new AudioContext({ sampleRate: 48000 }),
  worker,
  globals: globalThis as unknown as Record<string, unknown>,
};

runChecks(env).then((results) => {
  root.replaceChildren();
  const table = document.createElement('table');
  for (const r of results) {
    const row = table.insertRow();
    row.insertCell().textContent = r.name;
    const status = row.insertCell();
    status.textContent = r.ok ? 'ok' : 'FAIL';
    status.className = r.ok ? 'ok' : 'fail';
    row.insertCell().textContent = r.detail;
  }
  const copy = document.createElement('button');
  copy.textContent = 'Copy as JSON';
  copy.addEventListener('click', () => {
    const json = JSON.stringify({ userAgent: navigator.userAgent, results }, null, 2);
    void navigator.clipboard.writeText(json).catch(() => window.prompt('Copy:', json));
  });
  root.append(table, copy);
}).catch((err: unknown) => {
  root.textContent = `Probe failed: ${err instanceof Error ? err.message : String(err)}`;
});
