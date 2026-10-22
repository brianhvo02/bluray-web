import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StoredSubtitle } from '../../src/engine/disc/nas-api';
import { BadNameError, SubtitleStore, TooLargeError, type SubtitleMeta } from './subtitle-store';

const META: SubtitleMeta = {
  name: 'Fan subs', language: 'en', offsetMs: 0, uploaderPersonId: 'p1',
  attachment: { kind: 'chapter', discKey: 'disc-a', playlistId: '00001', chapter: 2 },
};

async function* body(...parts: (string | Buffer)[]): AsyncGenerator<Buffer> {
  for (const p of parts) yield Buffer.from(p);
}
const bytes = (n: number): AsyncGenerator<Buffer> => body(Buffer.alloc(n, 65));

let dir: string;
let clock: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'subs-'));
  clock = 1_000_000;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const make = (maxTotalBytes?: number): SubtitleStore => new SubtitleStore(dir, { maxTotalBytes, now: () => clock });
const leftovers = (id: string): string[] => readdirSync(join(dir, 'subtitles', id), { recursive: true }).map(String).filter((n) => n.includes('.tmp-'));

describe('SubtitleStore', () => {
  it('lists an upload only once it has a file', async () => {
    const s = make();
    const c = s.create(META);
    expect(c).toMatchObject({ fileSize: 0, fonts: [], uploadedAt: clock });
    expect(c.id).toMatch(/^[0-9a-f]{16}$/);
    expect(s.list()).toEqual([]);
    expect(s.filePath(c.id)).toBeNull();
    const w = await s.writeFile(c.id, 'ep1.srt', body('1\n00:00:01,000 --> 00:00:02,000\nhi\n'));
    expect(w.fileName).toBe('ep1.srt');
    expect(s.list().map((x: StoredSubtitle) => x.id)).toEqual([c.id]);
    expect(readFileSync(s.filePath(c.id)!, 'utf8')).toContain('hi');
    expect(s.get(c.id)).toEqual(w);
  });

  it('replaces an earlier file, even under another name', async () => {
    const s = make();
    const { id } = s.create(META);
    await s.writeFile(id, 'a.srt', body('one'));
    const w = await s.writeFile(id, 'b.ass', body('three'));
    expect(w).toMatchObject({ fileName: 'b.ass', fileSize: 5 });
    expect(existsSync(join(dir, 'subtitles', id, 'sub', 'a.srt'))).toBe(false);
    expect(readFileSync(s.filePath(id)!, 'utf8')).toBe('three');
  });

  it('refuses a subtitle over 5 MiB and leaves nothing behind', async () => {
    const s = make();
    const { id } = s.create(META);
    await expect(s.writeFile(id, 'big.srt', bytes(5 * 1024 * 1024 + 1))).rejects.toBeInstanceOf(TooLargeError);
    expect(leftovers(id)).toEqual([]);
    expect(existsSync(join(dir, 'subtitles', id, 'sub', 'big.srt'))).toBe(false);
    expect(s.list()).toEqual([]);
    await s.writeFile(id, 'ok.srt', bytes(5 * 1024 * 1024));
  });

  it('keeps the old file when a replacement is too large', async () => {
    const s = make();
    const { id } = s.create(META);
    await s.writeFile(id, 'a.srt', body('keep'));
    await expect(s.writeFile(id, 'a.srt', bytes(6 * 1024 * 1024))).rejects.toBeInstanceOf(TooLargeError);
    expect(readFileSync(s.filePath(id)!, 'utf8')).toBe('keep');
    expect(leftovers(id)).toEqual([]);
  });

  it('removes the temp file when the body fails midway', async () => {
    const s = make();
    const { id } = s.create(META);
    async function* broken(): AsyncGenerator<Buffer> {
      yield Buffer.from('x');
      throw new Error('socket closed');
    }
    await expect(s.writeFile(id, 'a.srt', broken())).rejects.toThrow('socket closed');
    expect(leftovers(id)).toEqual([]);
  });

  it('holds fonts to 50 MiB in all, and the same name replaces', async () => {
    const s = make();
    const { id } = s.create(META);
    const mib = 1024 * 1024;
    await s.writeFont(id, 'a.ttf', bytes(30 * mib));
    await expect(s.writeFont(id, 'b.otf', bytes(21 * mib))).rejects.toBeInstanceOf(TooLargeError);
    expect(leftovers(id)).toEqual([]);
    expect(s.get(id)!.fonts).toEqual([{ name: 'a.ttf', size: 30 * mib }]);
    const w = await s.writeFont(id, 'a.ttf', bytes(45 * mib));
    expect(w.fonts).toEqual([{ name: 'a.ttf', size: 45 * mib }]);
    await s.writeFont(id, 'b.woff2', bytes(5 * mib));
    expect(s.fontPath(id, 'b.woff2')).toBe(join(dir, 'subtitles', id, 'fonts', 'b.woff2'));
    expect(s.fontPath(id, 'nope.ttf')).toBeNull();
  });

  it('counts every upload against the total', async () => {
    const s = make(1_000);
    const a = s.create(META);
    const b = s.create(META);
    await s.writeFile(a.id, 'a.srt', bytes(600));
    await s.writeFont(a.id, 'f.ttf', bytes(300));
    await expect(s.writeFile(b.id, 'b.srt', bytes(101))).rejects.toBeInstanceOf(TooLargeError);
    await s.writeFile(b.id, 'b.srt', bytes(100));
    // Replacing counts only the difference.
    await s.writeFile(a.id, 'a.srt', bytes(600));
    await expect(s.writeFile(a.id, 'a.srt', bytes(601))).rejects.toBeInstanceOf(TooLargeError);
    expect(leftovers(a.id)).toEqual([]);
    expect(leftovers(b.id)).toEqual([]);
  });

  it.each(['../x.ttf', 'a/b.ass', 'x\0.ass', '.', '..', 'x.exe', '', `${'a'.repeat(252)}.ass`])('refuses the name %j', async (name) => {
    const s = make();
    const { id } = s.create(META);
    await expect(s.writeFile(id, name, body('x'))).rejects.toBeInstanceOf(BadNameError);
    await expect(s.writeFont(id, name, body('x'))).rejects.toBeInstanceOf(BadNameError);
    expect(leftovers(id)).toEqual([]);
  });

  it('refuses a font name on a subtitle and the reverse', async () => {
    const s = make();
    const { id } = s.create(META);
    await expect(s.writeFile(id, 'a.ttf', body('x'))).rejects.toBeInstanceOf(BadNameError);
    await expect(s.writeFont(id, 'a.srt', body('x'))).rejects.toBeInstanceOf(BadNameError);
    for (const ok of ['a.SRT', 'a.ssa', 'a.ass']) await s.writeFile(id, ok, body('x'));
    for (const ok of ['a.ttc', 'a.woff', 'a.otf']) await s.writeFont(id, ok, body('x'));
  });

  it('updates, deletes, and survives a new instance', async () => {
    const s = make();
    const { id } = s.create(META);
    await s.writeFile(id, 'a.srt', body('x'));
    const att = { kind: 'episode', discKey: 'disc-b', playlistId: '00002', titleId: 't', seasonId: 's', episode: 3 } as const;
    expect(s.update(id, { name: 'New', language: 'fr', offsetMs: -250, attachment: att })).toMatchObject({ name: 'New', language: 'fr', offsetMs: -250, attachment: att, fileName: 'a.srt' });
    expect(make().get(id)).toMatchObject({ name: 'New' });
    expect(s.update('0123456789abcdef', { name: 'x' })).toBeNull();
    expect(s.delete(id)).toBe(true);
    expect(s.delete(id)).toBe(false);
    expect(s.get(id)).toBeNull();
    expect(s.list()).toEqual([]);
  });

  it('ignores ids that are not ours', () => {
    const s = make();
    expect(s.get('../..')).toBeNull();
    expect(s.delete('../..')).toBe(false);
    expect(s.filePath('../x')).toBeNull();
  });

  it('removes an upload with no file after an hour', async () => {
    const s = make();
    const stale = s.create(META);
    clock += 30 * 60_000;
    const fresh = s.create(META);
    const done = s.create(META);
    await s.writeFile(done.id, 'a.srt', body('x'));
    clock += 30 * 60_000 + 1;
    expect(s.list().map((x) => x.id)).toEqual([done.id]);
    expect(s.get(stale.id)).toBeNull();
    expect(existsSync(join(dir, 'subtitles', stale.id))).toBe(false);
    expect(s.get(fresh.id)).not.toBeNull();
  });
});
