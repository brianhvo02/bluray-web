/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Every file of a committed disc under fixtures/synthetic/<name>/, keyed by its path relative to the disc root. */
export function fixtureDiscFiles(name: string): Map<string, Uint8Array<ArrayBuffer>> {
  const root = fileURLToPath(new URL(`../../fixtures/synthetic/${name}/`, import.meta.url));
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  const walk = (rel: string): void => {
    for (const entry of readdirSync(root + rel)) {
      const p = rel + entry;
      if (statSync(root + p).isDirectory()) walk(`${p}/`);
      else files.set(p, new Uint8Array(readFileSync(root + p)));
    }
  };
  walk('');
  return files;
}
