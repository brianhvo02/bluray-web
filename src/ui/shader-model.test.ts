import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { ShaderSetData } from '../engine/protocol';
import type { ShaderSetDef } from './shader-sets';
import type { ShaderLibrary, StoredShaderFile } from './shader-library';
import { ShaderModel } from './shader-model';

const DIR = 'fixtures/shaders/anime4k';
const MODE_A = 'Anime4K: Mode A (Fast)';
const MODE_A_FILES = [
  'Anime4K_Clamp_Highlights.glsl',
  'Anime4K_Restore_CNN_M.glsl',
  'Anime4K_Upscale_CNN_x2_M.glsl',
  'Anime4K_AutoDownscalePre_x2.glsl',
  'Anime4K_AutoDownscalePre_x4.glsl',
  'Anime4K_Upscale_CNN_x2_S.glsl',
];

function memoryLibrary(): ShaderLibrary & { store: Map<string, StoredShaderFile>; sel: { v: string | null } } {
  const store = new Map<string, StoredShaderFile>();
  const sets = new Map<string, ShaderSetDef>();
  const sel = { v: null as string | null };
  return {
    store,
    sel,
    files: async () => [...store.values()],
    putFiles: async (fs) => void fs.forEach((f) => store.set(f.name, f)),
    removeFile: async (n) => void store.delete(n),
    importedSets: async () => [...sets.values()],
    putImportedSets: async (ss) => void ss.forEach((s) => sets.set(s.name, s)),
    removeImportedSet: async (n) => void sets.delete(n),
    selected: async () => sel.v,
    setSelected: async (n) => void (sel.v = n),
  };
}

const fixture = (name: string, text = readFileSync(`${DIR}/${name}`, 'utf8')) => ({ name, text: async () => text, size: text.length });
const modeAFiles = () => MODE_A_FILES.map((n) => fixture(n));
const setup = () => {
  const lib = memoryLibrary();
  const apply = vi.fn<(s: ShaderSetData | null) => void>();
  const model = new ShaderModel(lib, apply, () => 100);
  return { lib, apply, model };
};

describe('ShaderModel', () => {
  it('makes Mode A available after adding its files', async () => {
    const { model } = setup();
    await model.load();
    await model.add(modeAFiles());
    const a = model.getSnapshot().sets.find((s) => s.name === MODE_A);
    expect(a?.available).toBe(true);
    expect(model.getSnapshot().report?.added).toHaveLength(6);
    expect(model.getSnapshot().files).toHaveLength(6);
  });

  it('select applies the set in order and persists; cycle goes Off → sets → Off', async () => {
    const { model, apply, lib } = setup();
    await model.load();
    await model.add(modeAFiles());
    await model.select(MODE_A);
    const arg = apply.mock.calls.at(-1)![0]!;
    expect(arg.name).toBe(MODE_A);
    expect(arg.files.map((f) => f.name)).toEqual(MODE_A_FILES);
    expect(arg.files[0]!.source).toBe(readFileSync(`${DIR}/${MODE_A_FILES[0]}`, 'utf8'));
    expect(lib.sel.v).toBe(MODE_A);

    await model.select(null);
    expect(apply).toHaveBeenLastCalledWith(null);
    const available = model.getSnapshot().sets.filter((s) => s.available).map((s) => s.name);
    await model.cycle();
    expect(model.getSnapshot().selected).toBe(available[0]);
    for (let i = 1; i < available.length; i++) {
      await model.cycle();
      expect(model.getSnapshot().selected).toBe(available[i]);
    }
    await model.cycle();
    expect(model.getSnapshot().selected).toBeNull();
    expect(apply).toHaveBeenLastCalledWith(null);
  });

  it('reports a rejected file with its reason and ignores other files silently', async () => {
    const { model } = setup();
    await model.load();
    await model.add([fixture('bad.glsl', 'not a shader'), fixture('readme.txt', 'hi'), fixture('huge.glsl', ''), { name: 'big.glsl', text: async () => '', size: 5 * 1024 * 1024 }]);
    const r = model.getSnapshot().report!;
    expect(r.added).toEqual([]);
    expect(r.rejected.map((x) => x.name).sort()).toEqual(['bad.glsl', 'big.glsl', 'huge.glsl']);
    expect(r.rejected.find((x) => x.name === 'bad.glsl')!.reason).toMatch(/HOOK/);
    expect(r.rejected.find((x) => x.name === 'big.glsl')!.reason).toMatch(/4 MiB/);
    model.dismissReport();
    expect(model.getSnapshot().report).toBeNull();
  });

  it('strips folder paths from names', async () => {
    const { model } = setup();
    await model.add([{ ...fixture('Anime4K_Clamp_Highlights.glsl'), name: 'shaders/sub\\Anime4K_Clamp_Highlights.glsl' }]);
    expect(model.getSnapshot().files).toEqual(['Anime4K_Clamp_Highlights.glsl']);
  });

  it('imports sets from an input.conf and counts them', async () => {
    const { model } = setup();
    await model.add([fixture('input.conf', 'CTRL+9 no-osd change-list glsl-shaders set "~~/shaders/mine.glsl"; show-text "Mine"\n')]);
    const s = model.getSnapshot();
    expect(s.report?.importedSets).toBe(1);
    expect(s.imported).toEqual(['Mine']);
    expect(s.sets.find((x) => x.name === 'Mine')?.available).toBe(false);
  });

  it('load applies a saved available set', async () => {
    const { lib, apply, model } = setup();
    await lib.putFiles(await Promise.all(modeAFiles().map(async (f) => ({ name: f.name, source: await f.text(), addedAt: 1 }))));
    lib.sel.v = MODE_A;
    await model.load();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]![0]!.name).toBe(MODE_A);
    expect(model.getSnapshot().selectedMissing).toBe(false);
  });

  it('load with a saved set whose file is missing keeps it selected, flags it and applies nothing', async () => {
    const { lib, apply, model } = setup();
    await lib.putFiles([{ name: MODE_A_FILES[0]!, source: readFileSync(`${DIR}/${MODE_A_FILES[0]}`, 'utf8'), addedAt: 1 }]);
    lib.sel.v = MODE_A;
    await model.load();
    expect(apply.mock.calls.every(([a]) => a === null)).toBe(true);
    expect(model.getSnapshot().selected).toBe(MODE_A);
    expect(model.getSnapshot().selectedMissing).toBe(true);
  });

  it('re-adding an active set file with new text applies again with the new source', async () => {
    const { model, apply } = setup();
    await model.add(modeAFiles());
    await model.select(MODE_A);
    apply.mockClear();
    const text = readFileSync(`${DIR}/${MODE_A_FILES[1]}`, 'utf8') + '\n// edited\n';
    await model.add([fixture(MODE_A_FILES[1]!, text)]);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]![0]!.files[1]!.source).toBe(text);
  });

  it('removing an active set file applies null and marks the selection missing', async () => {
    const { model, apply } = setup();
    await model.add(modeAFiles());
    await model.select(MODE_A);
    await model.removeFile(MODE_A_FILES[2]!);
    expect(apply).toHaveBeenLastCalledWith(null);
    expect(model.getSnapshot().selected).toBe(MODE_A);
    expect(model.getSnapshot().selectedMissing).toBe(true);
  });

  it('removeSet drops an imported set and clears the selection if it was active', async () => {
    const { model } = setup();
    await model.add([fixture('input.conf', 'K set glsl-shaders set "a.glsl"; show-text "Mine"\n')]);
    await model.select('Mine');
    await model.removeSet('Mine');
    expect(model.getSnapshot().imported).toEqual([]);
    expect(model.getSnapshot().selected).toBeNull();
  });

  it('notifies subscribers', async () => {
    const { model } = setup();
    const l = vi.fn();
    const off = model.subscribe(l);
    await model.add(modeAFiles());
    expect(l).toHaveBeenCalled();
    off();
    l.mockClear();
    model.dismissReport();
    expect(l).not.toHaveBeenCalled();
  });

  it('a select issued while add is pending wins everywhere', async () => {
    const { model, apply, lib } = setup();
    await model.add(modeAFiles());
    await model.select(MODE_A);
    await model.add([fixture('input.conf', 'K set glsl-shaders set "a.glsl"; show-text "Mine"\n')]);
    const slow = { name: 'Anime4K_Clamp_Highlights.glsl', size: 10, text: () => new Promise<string>((r) => setTimeout(() => r(readFileSync(`${DIR}/Anime4K_Clamp_Highlights.glsl`, 'utf8')), 20)) };
    const adding = model.add([slow]);
    const selecting = model.select('Mine');
    await Promise.all([adding, selecting]);
    expect(model.getSnapshot().selected).toBe('Mine');
    expect(lib.sel.v).toBe('Mine');
    expect(apply).toHaveBeenLastCalledWith(null);
  });

  it('two un-awaited cycles advance two steps', async () => {
    const { model } = setup();
    await model.add(modeAFiles());
    const available = model.getSnapshot().sets.filter((s) => s.available).map((s) => s.name);
    await Promise.all([model.cycle(), model.cycle()]);
    expect(model.getSnapshot().selected).toBe(available[1] ?? null);
  });

  it('re-importing an input.conf that redefines the active set re-applies it', async () => {
    const { model, apply } = setup();
    await model.add([fixture('input.conf', 'K set glsl-shaders set "a.glsl"; show-text "Mine"\n'), fixture('Anime4K_Clamp_Highlights.glsl'), fixture('Anime4K_Restore_CNN_M.glsl')]);
    await model.add([fixture('input.conf', 'K set glsl-shaders set "Anime4K_Clamp_Highlights.glsl"; show-text "Mine"\n')]);
    await model.select('Mine');
    apply.mockClear();
    await model.add([fixture('input.conf', 'K set glsl-shaders set "Anime4K_Restore_CNN_M.glsl"; show-text "Mine"\n')]);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]![0]!.files.map((f) => f.name)).toEqual(['Anime4K_Restore_CNN_M.glsl']);
  });

  it('renames an imported set named like a built-in; select applies its own list and cycle passes both', async () => {
    const { model, apply, lib } = setup();
    await model.add([...modeAFiles(), fixture('input.conf', `K glsl-shaders set "${MODE_A_FILES[0]}"; show-text "${MODE_A}"\n`)]);
    const renamed = `${MODE_A} (imported)`;
    expect(model.getSnapshot().imported).toEqual([renamed]);
    expect((await lib.importedSets()).map((s) => s.name)).toEqual([renamed]);
    const names = model.getSnapshot().sets.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);

    await model.select(renamed);
    expect(apply.mock.calls.at(-1)![0]!.files.map((f) => f.name)).toEqual([MODE_A_FILES[0]]);
    await model.select(MODE_A);
    expect(apply.mock.calls.at(-1)![0]!.files.map((f) => f.name)).toEqual(MODE_A_FILES);

    await model.select(null);
    const seen: (string | null)[] = [];
    for (let i = 0; i < 4; i++) {
      await model.cycle();
      seen.push(model.getSnapshot().selected);
    }
    expect(seen).toEqual([MODE_A, renamed, null, MODE_A]);
  });
});
