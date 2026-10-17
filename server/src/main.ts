import { loadConfig } from './config';
import { createServer } from './http';

const SHUTDOWN_GRACE_MS = 3_000;

const config = loadConfig(process.env);
const server = createServer([]);
server.listen(config.port, () => {
  console.log(`bluray-server listening on ${config.port}; roots: ${config.roots.map((r) => `${r.name}=${r.dir}`).join(', ')}`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    // Long disc streams would otherwise hold shutdown until Docker's SIGKILL.
    setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS).unref();
  });
}
