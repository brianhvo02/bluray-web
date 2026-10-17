import { runChecks, type ProbeEnv, type WorkerProbe } from './checks';

const root = document.getElementById('root') as HTMLElement;
const logView = document.createElement('pre');
const lines: string[] = [];
const t0 = performance.now();
/** Appends a timestamped line to the live log (kept in the copied JSON too). */
function log(line: string): void {
  lines.push(`${((performance.now() - t0) / 1000).toFixed(1)} s  ${line}`);
  logView.textContent = lines.join('\n');
}

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
      log(`files handed over (${input.files?.length ?? 0})`);
      button.disabled = true;
      resolve([...(input.files ?? [])]);
    });
    button.addEventListener('click', () => {
      log('picker opened');
      input.click();
    });
    root.append(button, input, logView);
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
  log,
};

runChecks(env).then((results) => {
  log('done');
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
    const json = JSON.stringify({ userAgent: navigator.userAgent, results, log: lines }, null, 2);
    void navigator.clipboard.writeText(json).catch(() => window.prompt('Copy:', json));
  });
  root.append(table, copy, logView);
}).catch((err: unknown) => {
  log(`probe failed: ${err instanceof Error ? err.message : String(err)}`);
  root.replaceChildren(logView);
});
