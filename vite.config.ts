import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

/** SharedArrayBuffer (the audio ring) requires cross-origin isolation. */
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectRegister: false,
      manifest: false, // public/manifest.webmanifest
      injectManifest: {
        rollupFormat: 'iife',
        globPatterns: ['**/*.{js,css,html,wasm,ttf,svg,png,webmanifest}'],
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
    include: ['src/**/*.test.ts', 'tests/local/**/*.test.ts', 'tests/vm-trace/**/*.test.ts', 'tests/ass-trace/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
});
