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
  const seen = new Set<string>();
  for (const { name } of roots) {
    if (seen.has(name)) throw new Error(`LIBRARY_ROOTS names "${name}" twice`);
    seen.add(name);
  }
  return { roots, dataDir: env.DATA_DIR ?? '/data', port: parsePort(env.PORT) };
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 8080;
  const port = Number(value);
  if (!/^\d+$/.test(value) || port > 65535) throw new Error(`PORT "${value}" is not a port number`);
  return port;
}
