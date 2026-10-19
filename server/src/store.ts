import { randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isCode, lockFile, replaceAtomically, syncDir, writeSynced } from './atomic-json';
import type { PairingCode, Person, StoredDevice } from './auth';

export interface AuthData {
  people: Person[];
  devices: StoredDevice[];
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

const randomId = (): string => randomBytes(16).toString('base64url');

/** Whether `parsed` is a step-2 file: devices and codes, no people. */
function isStep2(parsed: unknown): boolean {
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && !('people' in parsed) && 'devices' in parsed;
}

/**
 * Step 2 kept `owner` on devices and codes. All owner devices go to one person named Owner, each other device to a
 * person named after it, live owner codes to Owner, and live non-owner codes are dropped. The input is validated first.
 */
function migrate(file: string, parsed: unknown, now: number): unknown {
  const { devices, codes } = parsed as { devices: unknown; codes: unknown };
  if (!Array.isArray(devices)) fail(file, '"devices" is not an array');
  if (!Array.isArray(codes)) fail(file, '"codes" is not an array');
  const record = (where: string, value: unknown): Record<string, unknown> => {
    if (typeof value !== 'object' || value === null) fail(file, `${where} is not an object`);
    return value as Record<string, unknown>;
  };
  const oldDevices = devices.map((d, i) => record(`devices[${i}]`, d));
  const oldCodes = codes.map((c, i) => {
    const code = record(`codes[${i}]`, c);
    if (typeof code.expiresAt !== 'number') fail(file, `codes[${i}].expiresAt is not a number`);
    return code;
  });
  const people: Person[] = [];
  let owner: Person | undefined;
  const ownerPerson = (): Person => (owner ??= { id: randomId(), name: 'Owner', owner: true, createdAt: now });
  const migratedDevices = oldDevices.map((d) => {
    const { owner: wasOwner, ...rest } = d;
    if (wasOwner === true) return { ...rest, personId: ownerPerson().id };
    const person: Person = { id: randomId(), name: typeof d.name === 'string' && d.name.trim() ? d.name.trim().slice(0, 100) : 'Device', owner: false, createdAt: now };
    people.push(person);
    return { ...rest, personId: person.id };
  });
  const migratedCodes = oldCodes
    .filter((c) => c.owner === true && typeof c.expiresAt === 'number' && now < c.expiresAt)
    .map(({ owner: _owner, ...rest }) => ({ ...rest, personId: ownerPerson().id, invite: false }));
  return { people: owner ? [owner, ...people] : people, devices: migratedDevices, codes: migratedCodes };
}

/** Checks the parsed file's shape, so a damaged file stops every request instead of being half-read. */
function validate(file: string, parsed: unknown): AuthData {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) fail(file, 'not a JSON object');
  const { people, devices, codes } = parsed as Record<string, unknown>;
  if (!Array.isArray(people)) fail(file, '"people" is not an array');
  if (!Array.isArray(devices)) fail(file, '"devices" is not an array');
  if (!Array.isArray(codes)) fail(file, '"codes" is not an array');
  const fields = (where: string, value: unknown, shape: Record<string, 'string' | 'boolean' | 'number' | 'object'>): void => {
    if (typeof value !== 'object' || value === null) fail(file, `${where} is not an object`);
    for (const [key, type] of Object.entries(shape)) {
      const field = (value as Record<string, unknown>)[key];
      if (typeof field !== type || field === null) fail(file, `${where}.${key} is not a${type === 'object' ? 'n' : ''} ${type}`);
    }
  };
  people.forEach((p, i) => fields(`people[${i}]`, p, { id: 'string', name: 'string', owner: 'boolean', createdAt: 'number' }));
  devices.forEach((d, i) =>
    fields(`devices[${i}]`, d, { id: 'string', name: 'string', personId: 'string', publicKeyJwk: 'object', pairedAt: 'number', lastSeen: 'number' }),
  );
  codes.forEach((c, i) => fields(`codes[${i}]`, c, { id: 'string', hash: 'string', personId: 'string', invite: 'boolean', expiresAt: 'number' }));
  const ids = new Set((people as Person[]).map((p) => p.id));
  (devices as StoredDevice[]).forEach((d, i) => {
    if (!ids.has(d.personId)) fail(file, `devices[${i}].personId names an unknown person`);
  });
  (codes as PairingCode[]).forEach((c, i) => {
    if (!ids.has(c.personId)) fail(file, `codes[${i}].personId names an unknown person`);
  });
  return { people: people as Person[], devices: devices as StoredDevice[], codes: codes as PairingCode[] };
}

/**
 * Devices and pairing codes in `<dir>/auth.json`, and the token secret in `<dir>/secret`, both mode 600.
 * The running server and the `owner-code` command share the files, so every change re-reads the file
 * under a lock file and replaces it atomically (synced temp file, rename), and reads notice a newer file.
 * A step-2 file (no people) is migrated on load, and rewritten by the constructor.
 */
export class Store {
  private readonly file: string;
  private cached: { key: string; data: AuthData } | undefined;
  private secretBytes: Buffer | undefined;

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'auth.json');
    if (this.isStep2File()) {
      try {
        this.update(() => undefined);
      } catch {
        // A step-2 file that fails to migrate is reported by the first read, naming the fault.
      }
    }
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

  /** True for a readable step-2 file; anything else (absent, corrupt) is left for the first read to report. */
  private isStep2File(): boolean {
    try {
      return isStep2(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch {
      return false;
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
      if (isCode(err, 'ENOENT')) return { people: [], devices: [], codes: [] };
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      fail(this.file, 'not valid JSON');
    }
    return validate(this.file, isStep2(parsed) ? migrate(this.file, parsed, Date.now()) : parsed);
  }
}
