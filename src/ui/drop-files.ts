/** Subtitle and font files from a pick or a drop (folders walked one level of subfolders deep). */

export const SUBTITLE_EXTENSIONS: readonly string[] = ['.srt', '.ass', '.ssa'];
export const FONT_EXTENSIONS: readonly string[] = ['.ttf', '.otf', '.ttc', '.woff'];

const hasExtension = (file: File, list: readonly string[]): boolean => list.some((ext) => file.name.toLowerCase().endsWith(ext));

/** The subtitle files and the fonts of a pick, in pick order; anything else is ignored. */
export function splitPick(files: readonly File[]): { readonly subtitles: readonly File[]; readonly fonts: readonly File[] } {
  return { subtitles: files.filter((f) => hasExtension(f, SUBTITLE_EXTENSIONS)), fonts: files.filter((f) => hasExtension(f, FONT_EXTENSIONS)) };
}

interface Entry { readonly isFile: boolean; readonly isDirectory: boolean; readonly name: string }
interface FileEntryLike extends Entry { file(ok: (file: File) => void, fail?: (err: unknown) => void): void }
interface DirEntryLike extends Entry { createReader(): { readEntries(ok: (entries: Entry[]) => void, fail?: (err: unknown) => void): void } }

const fileOf = (e: FileEntryLike): Promise<File> => new Promise((ok, fail) => e.file(ok, fail));

async function childrenOf(dir: DirEntryLike): Promise<Entry[]> {
  const reader = dir.createReader();
  const out: Entry[] = [];
  for (;;) {
    const batch = await new Promise<Entry[]>((ok, fail) => reader.readEntries(ok, fail));
    if (!batch.length) return out;
    out.push(...batch);
  }
}

/** The files of a drop: plain files, and the files of dropped folders and of their subfolders (one level). */
export async function collectDroppedFiles(items: DataTransferItemList): Promise<File[]> {
  const entries: Entry[] = [];
  const plain: File[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.() as Entry | null;
    if (entry) entries.push(entry);
    else {
      const f = item.getAsFile();
      if (f) plain.push(f);
    }
  }
  const files: File[] = [...plain];
  const visit = async (entry: Entry, depth: number): Promise<void> => {
    if (entry.isFile) files.push(await fileOf(entry as FileEntryLike));
    else if (entry.isDirectory && depth <= 1) for (const child of await childrenOf(entry as DirEntryLike)) await visit(child, depth + 1);
  };
  for (const e of entries) await visit(e, 0);
  return files;
}
