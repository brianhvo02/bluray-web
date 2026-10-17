import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Device, PairingCode } from './auth';

export interface AuthData {
  devices: Device[];
  codes: PairingCode[];
}

const SECRET_BYTES = 32;
const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 10_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isCode(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === code;
}

/**
 * Devices and pairing codes in `<dir>/auth.json`, and the token secret in `<dir>/secret`, both mode 600.
 * The running server and the `owner-code` command share the files, so every change re-reads the file
 * under a lock file and replaces it atomically (temp file, rename), and reads notice a newer file.
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
    try {
      writeFileSync(path, randomBytes(SECRET_BYTES), { mode: 0o600, flag: 'wx' });
    } catch (err) {
      if (!isCode(err, 'EEXIST')) throw err;
    }
    const secret = readFileSync(path);
    if (secret.length !== SECRET_BYTES) throw new Error(`${path} is not a ${SECRET_BYTES}-byte secret`);
    this.secretBytes = secret;
    return secret;
  }

  /** The current data; callers must not change it. */
  read(): AuthData {
    const key = this.fileKey();
    if (this.cached?.key === key) return this.cached.data;
    const data = this.load();
    this.cached = { key, data };
    return data;
  }

  /** Runs `change` on a fresh copy of the data under the lock, then writes the result. */
  update<T>(change: (data: AuthData) => T): T {
    const release = this.lock();
    try {
      const data = this.load();
      const result = change(data);
      const temp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
      chmodSync(temp, 0o600);
      renameSync(temp, this.file);
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
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<AuthData>;
      return { devices: parsed.devices ?? [], codes: parsed.codes ?? [] };
    } catch (err) {
      if (isCode(err, 'ENOENT')) return { devices: [], codes: [] };
      throw err;
    }
  }

  private lock(): () => void {
    const path = `${this.file}.lock`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        closeSync(openSync(path, 'wx', 0o600));
        return () => unlinkSync(path);
      } catch (err) {
        if (!isCode(err, 'EEXIST')) throw err;
      }
      try {
        // A holder that died mid-write leaves its lock behind.
        if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) unlinkSync(path);
      } catch (err) {
        if (!isCode(err, 'ENOENT')) throw err;
      }
      if (Date.now() > deadline) throw new Error(`${path} is held`);
      sleepSync(10);
    }
  }
}
