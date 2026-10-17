import { join } from 'node:path';
import { loadConfig } from './config';
import { createServer } from './http';
import { Library, nextNightly } from './library';
import { libraryRoute } from './routes/library';

const SHUTDOWN_GRACE_MS = 3_000;

const config = loadConfig(process.env);
const library = new Library(config.roots, join(config.dataDir, 'library.json'), { scanPauseMs: config.scanPauseMs });
const server = createServer([libraryRoute(library)]);

function scheduleScans(): void {
  const run = (): void => {
    library.scan().catch((err: unknown) => console.error('library scan failed', err));
  };
  run();
  const arm = (): void => {
    setTimeout(() => {
      run();
      arm();
    }, nextNightly(new Date(), config.nightlyScanAt).getTime() - Date.now()).unref();
  };
  arm();
}

server.listen(config.port, () => {
  console.log(`bluray-server listening on ${config.port}; roots: ${config.roots.map((r) => `${r.name}=${r.dir}`).join(', ')}`);
  scheduleScans();
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    // Long disc streams would otherwise hold shutdown until Docker's SIGKILL.
    setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS).unref();
  });
}
