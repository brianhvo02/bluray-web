# bluray-web

Client-side Blu-ray (BDMV) player for the browser. Supported: Safari 26 (macOS, iOS, iPadOS), Chrome and Firefox on desktop (stable and stable−2), Chrome on Android. Firefox on Android is not supported. It works by touch, installs as an app and runs offline. Design: `docs/superpowers/specs/2026-10-12-bluray-web-player-design.md`.

**Run your own server:** the NAS server that serves your discs to the player, in Docker, is described in [docs/self-hosting.md](docs/self-hosting.md).

- `src/engine/` is derived from libbluray and licensed LGPL-2.1 (see `src/engine/LICENSE`).
- `npm run dev`: dev server (cross-origin isolated).
- `npm test`: unit tests. `npm run test:e2e`: Playwright (the `chromium` and `mobile-chromium` projects require Google Chrome; all projects need a working audio output; `--project=firefox|webkit|mobile-chromium` runs the others).
  The A/V sync checks allow 20 ms mean and 50 ms max offset; `SYNC_TOLERANCE_SCALE=2` doubles both on slower machines.
- `npm run wasm:build` rebuilds `src/wasm/audio/audio.wasm` (FFmpeg n9.0.2 AC-3, E-AC-3 and DTS decoders plus `shim.c`) and
  `src/wasm/freetype/freetype.wasm` (FreeType 2.13.2 as Ubuntu 24.04 ships it, for BD-J text) in Docker
  (`wasm:build:audio` / `wasm:build:freetype` build one). It needs Docker. The builds are reproducible, and
  `.github/workflows/wasm.yml` checks that the committed `.wasm` files match. `npm run bdj-trace:freetype-golden`
  regenerates `tests/bdj/fonts/freetype-golden.json` from the BD-J harness image's system FreeType.
- `npm run fixture:synthetic` regenerates `fixtures/synthetic/`. It needs `ffmpeg` on PATH, because the audio fixtures and
  `disc3` use its ac3, eac3, dca and truehd encoders. Their bytes depend on the host ffmpeg version (currently 9.0.2).
  `fixtures/synthetic/disc3` is the four-codec audio disc (LPCM, AC-3 5.1, TrueHD with an AC-3 core, DTS).
- `scripts/fetch-libbluray.sh` clones libbluray at the commit the engine is ported from into `.cache/libbluray` (gitignored),
  the reference for every ported function.
- The libbluray trace harness (`tools/vm-trace/`, Docker): `npm run vm-trace:build` builds patched libbluray and the harness,
  `npm run vm-trace:golden` regenerates `tests/vm-trace/golden/` from it (never edit those by hand), and
  `npm run vm-trace -- <disc> <script> [--dump-pages]` runs libbluray and our replay live and prints the first divergence.
  `npm test` replays the golden traces without Docker.
- Put your own decrypted discs under `fixtures/local/<name>/BDMV/...` to enable `tests/local`.
  `LOCAL_DISCS=1 npx playwright test local-discs` also plays each one in Chrome, seeks around it, switches audio tracks
  and checks every PG subtitle track. It decodes the PG streams in Node first to know where subtitles are due, and caches
  that in `fixtures/local/.pgscan-<name>.json`.

## Subtitles

Disc PG subtitles are picked from the Subtitles menu in the control bar. Forced captions show even with subtitles off.
An `.srt` file can be loaded from the same menu ("Load subtitle file…") or dropped on the player; files that are not
UTF-8 ask for their encoding. With a file loaded, the menu shifts its timing and changes its size. Keys: `S` cycles
Off, each disc track and the file; `[` and `]` move the file's subtitles 100 ms earlier or later.

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
