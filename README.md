# bluray-web

Client-side Blu-ray (BDMV) player for Chromium. Design: `docs/superpowers/specs/2026-10-12-bluray-web-player-design.md`.

- `src/engine/` is derived from libbluray and licensed LGPL-2.1 (see `src/engine/LICENSE`).
- `npm run dev`: dev server (cross-origin isolated).
- `npm test`: unit tests. `npm run test:e2e`: Playwright (requires Google Chrome).
- Put your own decrypted discs under `fixtures/local/<name>/BDMV/...` to enable `tests/local`.

## Nightly sync test

    npx tsx scripts/make-fixture-disc.ts fixtures/local/long-disc --seconds-per-clip 300
    NIGHTLY=1 npx playwright test -g "ten minutes"

## Deployment

The player needs `SharedArrayBuffer` (audio ring buffer), which browsers only expose to cross-origin isolated pages. A static deploy of `dist/` must therefore send these response headers on every file:

    Cross-Origin-Opener-Policy: same-origin
    Cross-Origin-Embedder-Policy: require-corp

`public/_headers` (copied into `dist/` by `npm run build`) does this on Netlify and Cloudflare Pages:

    /*
      Cross-Origin-Opener-Policy: same-origin
      Cross-Origin-Embedder-Policy: require-corp

Other hosts need the equivalent in their own configuration. Without the headers the app shows an error and cannot play.
