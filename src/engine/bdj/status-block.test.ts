import { describe, expect, it } from 'vitest';
import { StatusBlockReader, StatusBlockWriter, createStatusBlock } from './status-block';

describe('status block', () => {
  it('starts zeroed with no playlist open', () => {
    const r = new StatusBlockReader(createStatusBlock());
    expect([r.time45(), r.uoMask(), r.playlistOpen()]).toEqual([0n, 0n, false]);
  });

  it('carries time, the full 64-bit UO mask and the playlist state from writer to reader', () => {
    const buf = createStatusBlock();
    const w = new StatusBlockWriter(buf);
    const r = new StatusBlockReader(buf);
    w.setTime45(0xffffffffn);
    w.setUoMask(0x8000000000000003n);
    w.setPlaylistOpen(true);
    expect([r.time45(), r.uoMask(), r.playlistOpen()]).toEqual([0xffffffffn, 0x8000000000000003n, true]);
    w.setPlaylistOpen(false);
    expect(r.playlistOpen()).toBe(false);
  });
});
