import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

/** SharedArrayBuffer (the audio ring) requires cross-origin isolation. */
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

/**
 * The isolation headers on every response, 304s too: `server.headers`/`preview.headers` reach only full responses (sirv
 * leaves them off a 304), and WebKit refuses a worker whose revalidated script answers 304 without COEP, so a second
 * page load in a tab (a reload, or a link opened after the app) got no engine worker.
 */
const isolateEveryResponse: Plugin = {
  name: 'isolate-every-response',
  configureServer(server) {
    server.middlewares.use((_req, res, next) => {
      for (const [name, value] of Object.entries(crossOriginIsolation)) res.setHeader(name, value);
      next();
    });
  },
  configurePreviewServer(server) {
    server.middlewares.use((_req, res, next) => {
      for (const [name, value] of Object.entries(crossOriginIsolation)) res.setHeader(name, value);
      next();
    });
  },
};

export default defineConfig({
  plugins: [
    isolateEveryResponse,
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectRegister: false,
      manifest: false, // public/manifest.webmanifest
      injectManifest: {
        rollupFormat: 'iife',
        // jar: the BD-J class library (rt-bdj.jar is about 4 MB, over Workbox's 2 MiB default).
        globPatterns: ['**/*.{js,css,html,wasm,ttf,svg,png,webmanifest,jar}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        // The diagnostics page is online-only.
        globIgnores: ['probe.html', 'assets/probe-*.js'],
      },
    }),
  ],
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
  worker: { format: 'es' },
  build: { rollupOptions: { input: { main: resolve(root, 'index.html'), probe: resolve(root, 'probe.html') } } },
  test: {
    environment: 'node',
    passWithNoTests: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'tests/*.test.ts', 'tests/vm-trace/**/*.test.ts', 'tests/ass-trace/**/*.test.ts', 'tests/bdj/**/*.test.ts', 'tools/**/*.test.ts', 'server/**/*.test.ts', 'rendezvous/**/*.test.ts'],
          sequence: { groupOrder: 0 },
        },
      },
      {
        // The developer's real discs (they skip where fixtures/local is absent, as on CI). Their replays run against wall-time
        // limits, so they run after every other test, one file at a time, instead of racing the whole suite for the CPU.
        extends: true,
        test: { name: 'local', include: ['tests/local/**/*.test.ts'], fileParallelism: false, sequence: { groupOrder: 1 } },
      },
    ],
  },
});
