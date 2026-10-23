import { copyFileSync } from 'node:fs';
import { build } from 'esbuild';

await build({
  entryPoints: [new URL('src/main.ts', import.meta.url).pathname],
  outfile: new URL('dist/server.mjs', import.meta.url).pathname,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  logLevel: 'info',
  // CommonJS packages in the bundle (werift's `debug`) require Node's built-ins, which an ES module can only do
  // through a require of its own.
  banner: { js: "import { createRequire as __bundleRequire } from 'node:module'; const require = __bundleRequire(import.meta.url);" },
});

// 7-Zip's WASM (fansub archives, src/fansubs/archive.ts) is read from next to the bundle.
copyFileSync(new URL('../node_modules/7z-wasm/7zz.wasm', import.meta.url), new URL('dist/7zz.wasm', import.meta.url));
