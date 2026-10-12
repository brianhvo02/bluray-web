import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/** SharedArrayBuffer (the audio ring) requires cross-origin isolation. */
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react()],
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
  worker: { format: 'es' },
  test: {
    include: ['src/**/*.test.ts', 'tests/local/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
});
