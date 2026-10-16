import { validateShaderFile } from '../engine/shaders/parse';
import type { ShaderSetData } from '../engine/protocol';
import type { ShaderLibrary, StoredShaderFile } from './shader-library';
import { importedName, parseInputConf, resolveSets, type SetEntry, type ShaderSetDef } from './shader-sets';

export interface AddReport {
  readonly added: readonly string[];
  readonly rejected: readonly { readonly name: string; readonly reason: string }[];
  readonly importedSets: number;
}

export interface ShaderModelState {
  readonly sets: readonly SetEntry[];
  readonly files: readonly string[];
  readonly imported: readonly string[];
  readonly selected: string | null;
  /** The saved or chosen set exists but some of its files are not in the library, so nothing is applied. */
  readonly selectedMissing: boolean;
  readonly report: AddReport | null;
}

export interface PickedFile {
  readonly name: string;
  readonly text: () => Promise<string>;
  readonly size: number;
}

const baseName = (path: string): string => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);

/** Main-thread state behind the Shaders menu: the library, the selection and the last add report. */
export class ShaderModel {
  private state: ShaderModelState = { sets: [], files: [], imported: [], selected: null, selectedMissing: false, report: null };
  private sources = new Map<string, string>();
  private importedDefs: ShaderSetDef[] = [];
  private appliedKey: string | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly library: ShaderLibrary,
    private readonly apply: (set: ShaderSetData | null) => void,
    private readonly now: () => number = Date.now,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ShaderModelState => this.state;

  load(): Promise<void> {
    return this.enqueue(async () => {
      const selected = await this.library.selected();
      await this.refresh(selected);
      this.applySelection(true);
    });
  }

  select(name: string | null): Promise<void> {
    return this.enqueue(() => this.selectNow(name));
  }

  cycle(): Promise<void> {
    return this.enqueue(() => {
      const available = this.state.sets.filter((s) => s.available).map((s) => s.name);
      const i = this.state.selected === null ? -1 : available.indexOf(this.state.selected);
      return this.selectNow(i + 1 < available.length ? available[i + 1]! : null);
    });
  }

  add(files: readonly PickedFile[]): Promise<void> {
    return this.enqueue(async () => {
      const added: string[] = [];
      const rejected: { name: string; reason: string }[] = [];
      const stored: StoredShaderFile[] = [];
      const sets = new Map<string, ShaderSetDef>();
      for (const file of files) {
        const name = baseName(file.name);
        if (name === 'input.conf') {
          for (const parsed of parseInputConf(await file.text())) {
            const s = importedName(parsed);
            sets.set(s.name, s);
          }
        } else if (name.toLowerCase().endsWith('.glsl')) {
          // Oversize files are rejected before their text is read.
          const source = file.size > 4 * 1024 * 1024 ? '' : await file.text();
          const reason = validateShaderFile(name, source, file.size);
          if (reason === null) {
            stored.push({ name, source, addedAt: this.now() });
            added.push(name);
          } else rejected.push({ name, reason });
        }
      }
      await this.library.putFiles(stored);
      await this.library.putImportedSets([...sets.values()]);
      await this.refresh(this.state.selected, { added, rejected, importedSets: sets.size });
      this.applySelection(false);
    });
  }

  removeFile(name: string): Promise<void> {
    return this.enqueue(async () => {
      await this.library.removeFile(name);
      await this.refresh(this.state.selected, this.state.report);
      this.applySelection(false);
    });
  }

  removeSet(name: string): Promise<void> {
    return this.enqueue(async () => {
      const wasSelected = this.state.selected === name;
      await this.library.removeImportedSet(name);
      if (wasSelected) await this.library.setSelected(null);
      await this.refresh(wasSelected ? null : this.state.selected, this.state.report);
      this.applySelection(false);
    });
  }

  dismissReport(): void {
    if (this.state.report !== null) this.set({ report: null });
  }

  /** Runs mutating work one task at a time, reading state inside the task; a failure rejects its caller but not the chain. */
  private enqueue(task: () => Promise<void> | void): Promise<void> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async selectNow(name: string | null): Promise<void> {
    await this.library.setSelected(name);
    this.set({ selected: name });
    this.recompute();
    this.applySelection(true);
  }

  private async refresh(selected: string | null, report: AddReport | null = this.state.report): Promise<void> {
    const [files, imported] = await Promise.all([this.library.files(), this.library.importedSets()]);
    this.sources = new Map(files.map((f) => [f.name, f.source]));
    this.importedDefs = imported;
    this.set({ selected, report });
    this.recompute();
  }

  private recompute(): void {
    const sets = resolveSets(this.importedDefs, new Set(this.sources.keys()));
    const sel = this.state.selected;
    const entry = sel === null ? undefined : sets.find((s) => s.name === sel);
    this.set({
      sets,
      files: [...this.sources.keys()].sort(),
      imported: this.importedDefs.map((s) => s.name),
      selectedMissing: sel !== null && !entry?.available,
    });
  }

  /** Applies the selected set, or null for Off or a selection missing files. Unless forced, only when that differs from what was last applied. */
  private applySelection(force: boolean): void {
    const { selected, selectedMissing, sets } = this.state;
    const entry = selected === null || selectedMissing ? undefined : sets.find((s) => s.name === selected);
    const data: ShaderSetData | null = entry
      ? { name: entry.name, files: entry.files.map((name) => ({ name, source: this.sources.get(name)! })) }
      : null;
    const key = data === null ? null : JSON.stringify(data);
    if (!force && key === this.appliedKey) return;
    this.appliedKey = key;
    this.apply(data);
  }

  private set(patch: Partial<ShaderModelState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }
}
