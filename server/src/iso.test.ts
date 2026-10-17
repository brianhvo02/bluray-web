import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as udf from '../../src/engine/disc/udf';
import { IsoTrees } from './iso';

const ISO = join(import.meta.dirname, '../../fixtures/synthetic/disc1.iso');

describe('IsoTrees', () => {
  afterEach(() => vi.restoreAllMocks());

  it('parses each disc once and drops the least recently used past its bound', async () => {
    const parses = vi.spyOn(udf.UdfImage, 'open');
    const trees = new IsoTrees(2);
    expect((await trees.get('a', ISO)).get('BDMV/INDEX.BDMV')).toBeDefined();
    await trees.get('b', ISO);
    await trees.get('a', ISO);
    expect(parses).toHaveBeenCalledTimes(2);
    await trees.get('c', ISO); // evicts b, the least recently used
    await trees.get('a', ISO);
    expect(parses).toHaveBeenCalledTimes(3);
    await trees.get('b', ISO);
    expect(parses).toHaveBeenCalledTimes(4);
  });

  it('does not keep a failed parse', async () => {
    const trees = new IsoTrees(2);
    await expect(trees.get('x', join(import.meta.dirname, 'no-such.iso'))).rejects.toThrow();
    const parses = vi.spyOn(udf.UdfImage, 'open');
    await trees.get('x', ISO);
    expect(parses).toHaveBeenCalledTimes(1);
  });
});
