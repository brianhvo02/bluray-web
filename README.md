# bluray-web

Client-side Blu-ray (BDMV) player for Chromium. Design: `docs/superpowers/specs/2026-10-12-bluray-web-player-design.md`.

- `src/engine/` is derived from libbluray and licensed LGPL-2.1 (see `src/engine/LICENSE`).
- `npm run dev`: dev server (cross-origin isolated).
- `npm test`: unit tests. `npm run test:e2e`: Playwright (requires Google Chrome).
- Put your own decrypted discs under `fixtures/local/<name>/BDMV/...` to enable `tests/local`.
