# bluray-web

Client-side Blu-ray (BDMV) player for Chromium. Design: `docs/superpowers/specs/2026-10-12-bluray-web-player-design.md`.

- `src/engine/` is derived from libbluray and licensed LGPL-2.1 (see `src/engine/LICENSE`).
- `npm run dev`: dev server (cross-origin isolated).
- `npm test`: unit tests. `npm run test:e2e`: Playwright (requires Google Chrome and a working audio output).
  The A/V sync checks allow 20 ms mean and 50 ms max offset; `SYNC_TOLERANCE_SCALE=2` doubles both on slower machines.
- `npm run wasm:build` rebuilds `src/wasm/audio/audio.wasm` (FFmpeg n9.0.2 AC-3, E-AC-3 and DTS decoders plus `shim.c`) in Docker.
  It needs Docker. The build is reproducible, and `.github/workflows/wasm.yml` checks that the committed `audio.wasm` matches.
- `npm run fixture:synthetic` regenerates `fixtures/synthetic/`. It needs `ffmpeg` on PATH, because the audio fixtures and
  `disc3` use its ac3, eac3, dca and truehd encoders. Their bytes depend on the host ffmpeg version (currently 9.0.2).
  `fixtures/synthetic/disc3` is the four-codec audio disc (LPCM, AC-3 5.1, TrueHD with an AC-3 core, DTS).
- Put your own decrypted discs under `fixtures/local/<name>/BDMV/...` to enable `tests/local`.
  `LOCAL_DISCS=1 npx playwright test local-discs` also plays each one in Chrome and seeks around it.

## CI

`.github/workflows/ci.yml` runs typecheck and unit tests, then the Playwright suite in Chrome on `ubuntu-latest`.
`scripts/ci-audio.sh` gives the runner a PulseAudio null sink, because the sync tests need a running audio output.
CI uses `SYNC_TOLERANCE_SCALE=1.5`; local runs keep the default bounds.

To try the Linux setup locally in Docker, install Chrome from `dl.google.com/linux/direct/google-chrome-stable_current_<arch>.deb`.
Google ships arm64 builds, but `npx playwright install chrome` (Playwright 1.64) still refuses to run on Linux arm64.

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

Hosts must serve `.wasm` as `application/wasm`.

Other hosts need the equivalent in their own configuration. Without the headers the app shows an error and cannot play.
