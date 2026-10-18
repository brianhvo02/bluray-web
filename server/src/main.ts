import { join } from 'node:path';
import { appHandlers } from './app';
import { Auth } from './auth';
import { ownerCode } from './cli';
import type { CodeRegistrar } from './codes';
import { loadConfig } from './config';
import type { Config } from './config';
import { createServer } from './http';
import { Library, nextNightly } from './library';
import { RendezvousClient } from './rendezvous-client';
import { trustedProxy } from './routes/pair';
import { Store } from './store';

const SHUTDOWN_GRACE_MS = 3_000;

/** The rendezvous client when `RENDEZVOUS_URL` is set; its key lives next to the auth data. */
function rendezvousRegistrar(config: Config): CodeRegistrar | undefined {
  if (config.rendezvousUrl === undefined) return undefined;
  return new RendezvousClient(config.rendezvousUrl, join(config.dataDir, 'rendezvous-key.json'));
}

async function serve(config: Config): Promise<void> {
  const trustProxy = await trustedProxy(config.trustedProxy);
  const library = new Library(config.roots, join(config.dataDir, 'library.json'), { scanPauseMs: config.scanPauseMs });
  const auth = new Auth(new Store(config.dataDir), Date.now);
  const server = createServer(appHandlers({ auth, library, publicBase: config.publicBase, registrar: rendezvousRegistrar(config), trustProxy }));

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
  await serve(config);
} else if (command === 'owner-code') {
  const registrar = rendezvousRegistrar(config);
  await ownerCode(config.dataDir, Date.now, console.log, registrar && { registrar, publicBase: config.publicBase });
} else {
  console.error(`unknown command "${command}"; usage: node server.mjs [owner-code]`);
  process.exit(2);
}
