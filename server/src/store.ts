import { randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isCode, lockFile, replaceAtomically, syncDir, writeSynced } from './atomic-json';
import type { Device, PairingCode } from './auth';

export interface AuthData {
  devices: Device[];
  codes: PairingCode[];
}

const SECRET_BYTES = 32;

/**
 * Creates the mode-600 file `path` holding `data` unless it already exists. link() rather than rename():
 * a whole file appears or nothing, and a file another process made first is kept.
 */
export function createOnce(path: string, data: string | Buffer): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeSynced(temp, data);
  try {
    linkSync(temp, path);
    syncDir(dirname(path));
  } catch (err) {
    if (!isCode(err, 'EEXIST')) throw err;
  } finally {
    unlinkSync(temp);
  }
}

function fail(file: string, what: string): never {
  throw new Error(`${file} is corrupt: ${what}`);
}

/** Checks the parsed file's shape, so a damaged file stops every request instead of being half-read. */
function validate(file: string, parsed: unknown): AuthData {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) fail(file, 'not a JSON object');
  const { devices, codes } = parsed as Record<string, unknown>;
  if (!Array.isArray(devices)) fail(file, '"devices" is not an array');
  if (!Array.isArray(codes)) fail(file, '"codes" is not an array');
  const fields = (where: string, value: unknown, shape: Record<string, 'string' | 'boolean' | 'number' | 'object'>): void => {
    if (typeof value !== 'object' || value === null) fail(file, `${where} is not an object`);
    for (const [key, type] of Object.entries(shape)) {
      const field = (value as Record<string, unknown>)[key];
      if (typeof field !== type || field === null) fail(file, `${where}.${key} is not a${type === 'object' ? 'n' : ''} ${type}`);
    }
  };
  devices.forEach((d, i) =>
    fields(`devices[${i}]`, d, { id: 'string', name: 'string', owner: 'boolean', publicKeyJwk: 'object', pairedAt: 'number', lastSeen: 'number' }),
  );
  codes.forEach((c, i) => fields(`codes[${i}]`, c, { id: 'string', hash: 'string', owner: 'boolean', expiresAt: 'number' }));
  return { devices: devices as Device[], codes: codes as PairingCode[] };
}

/**
 * Devices and pairing codes in `<dir>/auth.json`, and the token secret in `<dir>/secret`, both mode 600.
 * The running server and the `owner-code` command share the files, so every change re-reads the file
 * under a lock file and replaces it atomically (synced temp file, rename), and reads notice a newer file.
 */
export class Store {
  private readonly file: string;
  private cached: { key: string; data: AuthData } | undefined;
  private secretBytes: Buffer | undefined;

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'auth.json');
  }

  /** The HMAC key for session tokens, made on first use. */
  secret(): Buffer {
    if (this.secretBytes) return this.secretBytes;
    const path = join(this.dir, 'secret');
    createOnce(path, randomBytes(SECRET_BYTES));
    const secret = readFileSync(path);
    if (secret.length !== SECRET_BYTES) throw new Error(`${path} is not a ${SECRET_BYTES}-byte secret`);
    this.secretBytes = secret;
    return secret;
  }

  /** The current data; callers must not change it. Throws, naming the file, when it is corrupt. */
  read(): AuthData {
    const key = this.fileKey();
    if (this.cached?.key === key) return this.cached.data;
    const data = this.load();
    this.cached = { key, data };
    return data;
  }

  /** Runs `change` on a fresh copy of the data under the lock, then writes the result. */
  update<T>(change: (data: AuthData) => T): T {
    const release = lockFile(this.file);
    try {
      const data = this.load();
      const result = change(data);
      replaceAtomically(this.file, JSON.stringify(data));
      this.cached = { key: this.fileKey(), data };
      return result;
    } finally {
      release();
    }
  }

  private fileKey(): string {
    try {
      const s = statSync(this.file);
      return `${s.ino}:${s.mtimeMs}:${s.size}`;
    } catch (err) {
      if (isCode(err, 'ENOENT')) return 'none';
      throw err;
    }
  }

  private load(): AuthData {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (err) {
      if (isCode(err, 'ENOENT')) return { devices: [], codes: [] };
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      fail(this.file, 'not valid JSON');
    }
    return validate(this.file, parsed);
  }
}
