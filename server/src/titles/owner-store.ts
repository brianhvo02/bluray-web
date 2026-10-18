import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OwnerChoice, OwnTitle, TitleKind } from '../../../src/engine/disc/nas-api';
import { isCode, lockFile, replaceAtomically } from '../atomic-json';

export interface OwnerSnapshot {
  readonly choices: ReadonlyMap<string, OwnerChoice>;
  readonly ownTitles: readonly OwnTitle[];
  readonly displayNames: ReadonlyMap<string, string>;
  readonly gate: 'owners' | 'everyone' | null;
}

interface OwnerData {
  choices: Record<string, { choice: OwnerChoice; fingerprint: string | null }>;
  ownTitles: OwnTitle[];
  displayNames: Record<string, string>;
  gate: 'owners' | 'everyone' | null;
}

function fail(file: string, what: string): never {
  throw new Error(`${file} is corrupt: ${what}`);
}

/**
 * The owner's choices per disc, own titles, display names and the library gate, in `<dir>/owner.json`.
 * Choices are keyed by disc id and carry the disc's content fingerprint so `reattach` can follow a moved disc.
 * Every change re-reads the file under a lock and replaces it atomically, like `Store`.
 */
export class OwnerStore {
  private readonly file: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'owner.json');
  }

  snapshot(): OwnerSnapshot {
    const data = this.load();
    return {
      choices: new Map(Object.entries(data.choices).map(([id, c]) => [id, c.choice])),
      ownTitles: data.ownTitles,
      displayNames: new Map(Object.entries(data.displayNames)),
      gate: data.gate,
    };
  }

  setChoice(discId: string, fingerprint: string | null, choice: OwnerChoice): void {
    this.update((d) => {
      d.choices[discId] = { choice, fingerprint };
    });
  }

  clearChoice(discId: string): void {
    this.update((d) => {
      delete d.choices[discId];
    });
  }

  /** `id` is a disc id or a music title id; null clears the name. */
  setDisplayName(id: string, name: string | null): void {
    this.update((d) => {
      if (name === null) delete d.displayNames[id];
      else d.displayNames[id] = name;
    });
  }

  createTitle(kind: TitleKind, name: string, seasons: number | null): OwnTitle {
    const title: OwnTitle = { id: `own:${randomUUID()}`, kind, name, seasons };
    this.update((d) => {
      d.ownTitles.push(title);
    });
    return title;
  }

  updateTitle(id: string, change: { name?: string; seasons?: number | null }): OwnTitle {
    return this.update((d) => {
      const at = d.ownTitles.findIndex((t) => t.id === id);
      if (at < 0) throw new Error(`No own title ${id}`);
      const next: OwnTitle = {
        ...d.ownTitles[at]!,
        ...(change.name !== undefined ? { name: change.name } : {}),
        ...(change.seasons !== undefined ? { seasons: change.seasons } : {}),
      };
      d.ownTitles[at] = next;
      return next;
    });
  }

  /** Also clears every choice naming the title, so those discs return to Unsorted. */
  deleteTitle(id: string): void {
    this.update((d) => {
      d.ownTitles = d.ownTitles.filter((t) => t.id !== id);
      for (const [discId, c] of Object.entries(d.choices)) {
        if ((c.choice.kind === 'title' || c.choice.kind === 'extras') && c.choice.titleId === id) delete d.choices[discId];
      }
    });
  }

  setGate(gate: 'owners' | 'everyone'): void {
    this.update((d) => {
      d.gate = gate;
    });
  }

  /**
   * Follows moved discs: a choice whose disc id is absent moves to every present disc with the same non-null
   * fingerprint. A choice without a fingerprint stays under its id. An existing choice on a present disc wins.
   */
  reattach(discs: readonly { id: string; fingerprint: string | null }[]): void {
    const present = new Set(discs.map((d) => d.id));
    this.update((d) => {
      for (const [oldId, entry] of Object.entries(d.choices)) {
        if (present.has(oldId) || entry.fingerprint === null) continue;
        const targets = discs.filter((x) => x.fingerprint === entry.fingerprint && d.choices[x.id] === undefined);
        if (targets.length === 0) continue;
        for (const t of targets) d.choices[t.id] = { choice: entry.choice, fingerprint: entry.fingerprint };
        delete d.choices[oldId];
      }
    });
  }

  private update<T>(change: (data: OwnerData) => T): T {
    const release = lockFile(this.file);
    try {
      const data = this.load();
      const result = change(data);
      replaceAtomically(this.file, JSON.stringify(data));
      return result;
    } finally {
      release();
    }
  }

  private load(): OwnerData {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (err) {
      if (isCode(err, 'ENOENT')) return { choices: {}, ownTitles: [], displayNames: {}, gate: null };
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      fail(this.file, 'not valid JSON');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) fail(this.file, 'not a JSON object');
    const { choices, ownTitles, displayNames, gate } = parsed as Record<string, unknown>;
    const isObj = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v);
    if (!isObj(choices)) fail(this.file, '"choices" is not an object');
    if (!Array.isArray(ownTitles)) fail(this.file, '"ownTitles" is not an array');
    if (!isObj(displayNames)) fail(this.file, '"displayNames" is not an object');
    if (gate !== null && gate !== 'owners' && gate !== 'everyone') fail(this.file, '"gate" is not owners, everyone or null');
    return parsed as OwnerData;
  }
}
