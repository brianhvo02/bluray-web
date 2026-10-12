import { DiscError } from './byte-source';

/**
 * Maps picked files (relative paths as reported by the picker) to disc-relative upper-case paths,
 * rooted at the folder that contains BDMV. Accepts the disc root, the BDMV folder itself, or a
 * parent folder containing exactly one disc.
 */
export function normalizeDiscPaths(entries: ReadonlyArray<readonly [string, Blob]>): Map<string, Blob> {
  const roots = new Set<string>();
  for (const [path] of entries) {
    const segments = path.split('/').filter(Boolean);
    const bdmvAt = segments.findIndex((s) => s.toUpperCase() === 'BDMV');
    if (bdmvAt >= 0) roots.add(segments.slice(0, bdmvAt).join('/'));
  }
  if (roots.size === 0) throw new DiscError('not-bdmv', 'No BDMV folder was found in the selected folder.');
  if (roots.size > 1) {
    throw new DiscError('multiple-discs', 'The selected folder contains more than one disc. Pick a single disc folder.', [...roots].sort());
  }
  const [root] = [...roots];
  const prefix = root === '' ? '' : `${root}/`;
  const files = new Map<string, Blob>();
  for (const [path, blob] of entries) {
    const relative = path.split('/').filter(Boolean).join('/');
    if (prefix !== '' && !relative.startsWith(prefix)) continue;
    files.set(relative.slice(prefix.length).toUpperCase(), blob);
  }
  return files;
}
