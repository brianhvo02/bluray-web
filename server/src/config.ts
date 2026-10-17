export interface LibraryRoot {
  name: string;
  dir: string;
}

export interface Config {
  roots: LibraryRoot[];
  dataDir: string;
  port: number;
}

/** Reads `LIBRARY_ROOTS` (comma-separated `name=dir`), `DATA_DIR` and `PORT`. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const roots = (env.LIBRARY_ROOTS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      const eq = entry.indexOf('=');
      if (eq <= 0 || eq === entry.length - 1) throw new Error(`LIBRARY_ROOTS entry "${entry}" is not name=dir`);
      return { name: entry.slice(0, eq), dir: entry.slice(eq + 1) };
    });
  const port = Number(env.PORT ?? '8080');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`PORT "${env.PORT}" is not a port number`);
  return { roots, dataDir: env.DATA_DIR ?? '/data', port };
}
