import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FansubTitleState } from '../../../src/engine/disc/nas-api';
import { isCode, lockFile, replaceAtomically } from '../atomic-json';

const THIRTY_DAYS_MS = 30 * 86_400_000;

interface StateFile {
  titles: Record<string, FansubTitleState>;
  /** Tracks the owner deleted, per title, as `"<toshoFileId>:<track>"`. */
  deleted: Record<string, string[]>;
  languages: string[];
}

const trackKey = (toshoFileId: number, track: number): string => `${toshoFileId}:${track}`;

/** The fansub run's memory: per-title results, tracks the owner deleted and the languages wanted. `<dataDir>/fansubs/state.json`. */
export class FansubState {
  private readonly file: string;

  constructor(dataDir: string) {
    const dir = join(dataDir, 'fansubs');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, 'state.json');
  }

  title(id: string): FansubTitleState | null {
    return this.read().titles[id] ?? null;
  }

  put(state: FansubTitleState): void {
    this.change((s) => {
      s.titles[state.titleId] = state;
    });
  }

  isDeleted(toshoFileId: number, track: number): boolean {
    const key = trackKey(toshoFileId, track);
    return Object.values(this.read().deleted).some((keys) => keys.includes(key));
  }

  /** Records a deleted track against the title its subtitle was attached to, so `undelete(titleId)` can bring it back. */
  markDeleted(titleId: string, toshoFileId: number, track: number): void {
    this.change((s) => {
      const keys = (s.deleted[titleId] ??= []);
      const key = trackKey(toshoFileId, track);
      if (!keys.includes(key)) keys.push(key);
    });
  }

  undelete(titleId: string): void {
    this.change((s) => {
      delete s.deleted[titleId];
    });
  }

  /** ISO 639-2 codes of the languages to fetch, `['eng']` until the owner sets them. */
  languages(): readonly string[] {
    return this.read().languages;
  }

  setLanguages(codes: readonly string[]): void {
    this.change((s) => {
      s.languages = [...codes];
    });
  }

  /** The titles to run: never run, or nothing found and the last run over 30 days ago. */
  due(titleIds: readonly string[], now: number): string[] {
    const { titles } = this.read();
    return titleIds.filter((id) => {
      const t = titles[id];
      return !t || t.lastRunAt === null || (t.nothingFound && now - t.lastRunAt > THIRTY_DAYS_MS);
    });
  }

  private read(): StateFile {
    let parsed: Partial<StateFile> = {};
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StateFile>;
    } catch (err) {
      // Missing is normal; damaged starts over (the run redoes what it forgot).
      if (!isCode(err, 'ENOENT') && !(err instanceof SyntaxError)) throw err;
    }
    const languages = Array.isArray(parsed.languages) && parsed.languages.length > 0 ? parsed.languages : ['eng'];
    return { titles: parsed.titles ?? {}, deleted: parsed.deleted ?? {}, languages };
  }

  private change(edit: (s: StateFile) => void): void {
    const unlock = lockFile(this.file);
    try {
      const s = this.read();
      edit(s);
      replaceAtomically(this.file, JSON.stringify(s));
    } finally {
      unlock();
    }
  }
}
