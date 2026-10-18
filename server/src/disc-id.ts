import { createHash } from 'node:crypto';

/** A disc's stable id: 16 hex chars of sha256 over its path and the identity of its index.bdmv. */
export function discId(rootRelativePath: string, indexSize: number, indexMtimeMs: number): string {
  return createHash('sha256').update(`${rootRelativePath}\0${indexSize}\0${Math.floor(indexMtimeMs)}`).digest('hex').slice(0, 16);
}
