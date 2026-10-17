import { join } from 'node:path';
import { appHandlers } from './app';
import { Auth } from './auth';
import { ownerCode } from './cli';
import { loadConfig } from './config';
import type { Config } from './config';
import { createServer } from './http';
import { Library, nextNightly } from './library';
import { Store } from './store';

const SHUTDOWN_GRACE_MS = 3_000;

function serve(config: Config): void {
  const library = new Library(config.roots, join(config.dataDir, 'library.json'), { scanPauseMs: config.scanPauseMs });
  const auth = new Auth(new Store(config.dataDir), Date.now);
  const server = createServer(appHandlers({ auth, library, publicBase: config.publicBase }));

  const scheduleScans = (): void => {
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
  };

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
}

const config = loadConfig(process.env);
const command = process.argv[2];
if (command === undefined) {
  serve(config);
} else if (command === 'owner-code') {
  ownerCode(config.dataDir);
} else {
  console.error(`unknown command "${command}"; usage: node server.mjs [owner-code]`);
  process.exit(2);
}
