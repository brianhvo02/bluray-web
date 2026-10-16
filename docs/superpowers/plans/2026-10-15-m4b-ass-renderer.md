# Milestone 4b: Native ASS Renderer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** User-loaded `.ass`/`.ssa` files, with their fonts, rendered on the player canvas close to libass, including full fansub typesetting, verified against a pinned libass by layout traces and golden images.

**Architecture:** libass 0.17.5's parser (`ass.c`), override-tag engine (`ass_parse.c`), drawing parser (`ass_drawing.c`), font matching (`ass_fontselect.c`, metrics from `ass_font.c`) and the layout half of `ass_render.c` are ported to TypeScript under `src/engine/ass/`. Glyph shaping and rasterization are the browser's (Canvas2D in the engine worker, fonts registered as `FontFace`s); the compositing rules of `render_and_combine_glyphs` are ported on top. A Docker harness built from patched libass writes JSON layout traces and PNG goldens; Playwright compares our layout and pixels in Chrome. `AssRenderer` plugs into M4a's text track, which becomes a set of files placed at episode starts (`subs/text-set.ts`).

**Tech Stack:** TypeScript (strict), React 19, Vite 8, Vitest 5, Playwright 1.64 (Chrome), `pixelmatch` (dev only); C (libass 0.17.5, FreeType, HarfBuzz, FriBidi from Ubuntu 24.04) in Docker for the harness.

**Spec:** `docs/superpowers/specs/2026-10-15-m4b-ass-renderer-design.md` (parent: `docs/superpowers/specs/2026-10-12-bluray-web-player-design.md`; M4a: `docs/superpowers/specs/2026-10-15-m4a-pgs-srt-design.md`). Read all three.

## How port tasks are written

As in M3 and M4a, port tasks name the exact libass functions to translate; that C is the reference and is followed line by line, keeping libass's names in comments where ours differ. Get it with `scripts/fetch-libass.sh` (Task 1). Paths are relative to `.cache/libass/libass/`. Interfaces, tests and acceptance checks are given in full. Where libass works on FreeType outlines or bitmaps and we cannot, the task says what replaces it.

## Global Constraints

- Ported code lives in `src/engine/ass/`, carries the header below, and is listed in `src/engine/NOTICE` with its libass source files; the NOTICE reproduces libass's ISC copyright and permission notice from `COPYING`. Original files say "Original implementation for bluray-web, 2026; contains no libass, libbluray or FFmpeg code." and are `LGPL-2.1-or-later`.
  ```ts
  /*
   * <what the file does>
   *
   * Ported from libass 0.17.5 (<file.c>): <functions>. libass is ISC-licensed; see src/engine/NOTICE.
   * Modified for bluray-web, 2026.
   *
   * SPDX-License-Identifier: LGPL-2.1-or-later AND ISC
   */
  ```
- Port from libass tag 0.17.5, commit `4a05d8127f525943ebf45fdc6497c9e665947f0d`, only.
- Engine code must not import React or anything from `src/ui/` or `src/player/`. Browser APIs (`FontFace`, `OffscreenCanvas`, `ctx.measureText`) stay behind injectable interfaces (`FontLoader`, `GlyphMeasurer`), as `PlayerDeps` does.
- No new runtime dependencies. One new dev dependency: `pixelmatch@7.1.0`.
- TypeScript strict with `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`; few comments, explaining why; `readonly` interface fields.
- Times inside `ass/` are integer milliseconds, as in libass (`long long` ms); the boundary to the player converts from µs.
- Colours are libass's `uint32` `0xRRGGBBAA` with AA = transparency (0 opaque, 0xFF invisible).
- Harness settings (§6.1 of the spec), used identically by our Chrome page: frame and storage size 1920×1080, font scale 1, `ASS_HINTING_NONE`, `ASS_SHAPING_COMPLEX`, no colour-matrix conversion (libass does none; see Deviation 7), no font provider (`ASS_FONTPROVIDER_NONE`), default font DejaVu Sans, use_margins off, line position 0.
- Pixel comparison budget: differing pixels ≤ 0.5% of the event box area of the frame's events, and never more than `max(64, that)`; `pixelmatch` threshold 0.1, `includeAA: false`. Layout position tolerance: 0.5 px.
- Performance: static frames under 1 ms; the 95th percentile of animated frames under 8 ms (`ass.overBudget` counts frames over 8 ms).
- Size caps (UI): a subtitle file at most `MAX_SUBTITLE_FILE_BYTES` (existing); fonts at most 64 MiB each and 256 MiB per load, with the notice `Fonts over the size limit were skipped: <names>`.
- Large files: 50 000 events parse in under 2 s; a frame looks only at active events (interval index); the static cache is an LRU of 64 events.
- Episode sets: at most 64 subtitle files; episode starts are play items of at least 5 minutes (`MIN_EPISODE_US`), or every item when none is; numeric name order (`Intl.Collator(undefined, { numeric: true })`).
- Notices (exact text): placement `Place each subtitle file at its episode's start in the subtitle menu`; unreadable file in a set `<name>: this file has no subtitles we can read`; too many files `Only the first 64 subtitle files were loaded`; missing families `Some fonts are missing and were replaced: <families joined by ", ">`; unreadable fonts `Some font files could not be read: <file names>`.
- Existing behaviour stays: every existing test keeps passing; SRT rendering is unchanged.

### Deviations from the spec (decided while planning)

1. **The harness libass is built without libunibreak** (`-Dlibunibreak=disabled`), so lines break only where libass breaks without it (spaces and ZWSP). We port that branch of `wrap_lines_naive`; it is the behaviour of most ffmpeg builds.
2. **No FriBidi reordering across style runs.** `reorder_text` is ported for the left-to-right case only; a run's text goes to `fillText` whole, so Chrome reorders right-to-left text within a run. Mixed-direction text across runs is recorded in `docs/known-issues.md`.
3. **WOFF2 is not accepted.** We read font name and metric tables ourselves (§Task 4); WOFF needs only `DecompressionStream('deflate')`, but WOFF2 needs Brotli and table transforms. Fansub fonts are TTF/OTF. Accepted: `.ttf .otf .ttc .woff`.
4. **Goldens are opaque**: libass's images are blended onto a solid `#808080` frame, and our page fills the same colour first, so `pixelmatch` compares like with like.
5. **Fonts are matched when the track loads, not lazily**: every family named by a style or an `\fn` tag is matched and its `FontFace` loaded before the track becomes active, because `FontFace.load()` is asynchronous and libass's rendering is not. Unused fonts in a pick are never registered, which is what "lazily" was for.
6. **Synthetic bold and italic are ours, not Chrome's**: libass emboldens (`ass_glyph_embolden`) and slants (`ass_glyph_italicize`) a face that lacks the requested weight or style; we register each face under a private family with its real descriptors and apply the same strength and shear when drawing, rather than letting Chrome synthesize.
7. **Colour-matrix conversion is the player's, not libass's.** libass never reads `YCbCr Matrix` while rendering (spec §3.3 said it converts; that was wrong): players such as mpv convert. `AssRenderer` takes `colorMatrix: 'video' | 'none'`. With `'video'` (the player), colours of a script whose matrix is `TV.601`/`PC.601`, or `Default`/missing (VSFilter's legacy assumption of BT.601), are converted RGB → YCbCr with BT.601 → RGB with BT.709 (Blu-ray video), the TV/PC range kept; `None`, `TV.709`/`PC.709` and others are left as they are. The trace page uses `'none'`, so goldens compare unconverted colours.

## Review Focus

1. **A seek, offset change or rectangle resize while an animated sign is on screen.** The sign is redrawn for the new time at once; collision memory is cleared on seek so a dialogue line does not stay shifted by an event that is no longer shown. Task 14 has a test.
2. **A file whose styles name fonts the user did not supply.** The track still loads and draws in the fallback, `missingFonts` lists each family once (case-insensitive), the notice appears once, and "Add fonts…" with the right file clears it and redraws in the right face. Tasks 5, 17 and 19 have tests.
3. **Malformed real-world input**: a `[Events]` `Format:` with reordered or missing fields, a style named in an event that does not exist, unclosed `{`, `\t` with no tags, `\pos` given twice, `\clip` with 3 numbers, negative or huge `\fs`/`\bord`, an event with an empty text. No exception; libass's result. Tasks 3 and 6 have tests.
4. **A set whose files outnumber the episode starts, or a playlist change mid-set.** Only the first file is placed, the notice says how to place the rest, and playing another playlist and coming back restores the user's placements for each. Tasks 16 and 17 have tests.
5. **Switching subtitle files or closing the disc while fonts are still loading.** The late fonts and track are discarded; nothing from the old file is drawn or reported. Task 17 has a test.

---

## File map

| File | Status | Task |
|---|---|---|
| `scripts/fetch-libass.sh`, `scripts/fetch-ass-fonts.sh`, `fixtures/ass/fonts/*` | create | 1 |
| `tools/ass-trace/{Dockerfile,trace.patch,ass_trace.c,build.sh,run.sh,golden.sh,README.md}` | create | 1 |
| `tests/ass-trace/{format.ts,png.ts,run.ts}`, `tests/ass-trace/golden/*`, `fixtures/ass/basic/*` | create | 1 |
| `.github/workflows/ass-trace.yml`, `package.json` scripts | create / modify | 1 |
| `tests/ass-trace/{compare.ts,compare.test.ts,pixels.ts,pixels.test.ts}` | create | 2 |
| `src/engine/ass/types.ts`, `src/engine/ass/parse.ts` | create | 3 |
| `src/engine/ass/font-tables.ts` | create | 4 |
| `src/engine/ass/fonts.ts` | create | 5 |
| `src/engine/ass/state.ts`, `src/engine/ass/tags.ts` | create | 6 |
| `src/engine/ass/events.ts` (parse_events, karaoke) | create | 7 |
| `src/engine/ass/drawing.ts` | create | 8 |
| `src/engine/ass/measure.ts`, `src/engine/ass/layout.ts` | create | 9 |
| `src/engine/ass/transform.ts`, `src/engine/ass/collisions.ts`, `src/engine/ass/frame.ts` | create | 10 |
| `src/engine/ass/trace.ts`, `tests/ass-trace/page/*` (incl. `types.ts`), `tests/ass-trace/layout.spec.ts`, `playwright.ass.config.ts`, `fixtures/ass/*` | create | 11 |
| `src/engine/ass/raster.ts` | create | 12 |
| `src/engine/ass/warp.ts` | create | 13 |
| `src/engine/ass/renderer.ts` | create | 14 |
| `tests/ass-trace/pixels.spec.ts` | create | 15 |
| `src/engine/subs/text-set.ts` | create | 16 |
| `src/engine/protocol.ts`, `src/engine/player.ts`, `src/engine/render/compositor.ts`, `src/engine/subs/text-renderer.ts`, `src/engine/worker.ts` | modify | 17 |
| `src/player/player-controller.ts`, `src/ui/SubtitleMenu.tsx`, `src/ui/EncodingPrompt.tsx`, `src/ui/PlayerScreen.tsx`, `src/ui/drop-files.ts`, `src/ui/subtitle-starts.ts` | modify / create | 18 |
| `tests/e2e/subtitles.spec.ts`, `tests/e2e/fixtures/*.ass`, `tests/helpers/font-rename.ts` | modify / create | 19 |
| `tests/ass-trace/local.spec.ts`, `tests/ass-trace/times.ts` | create | 20 |
| docs, `src/engine/NOTICE`, `CLAUDE.md` | modify | 21 |

---

## Phase A: the libass harness

### Task 1: Docker harness, trace format and the first golden

**Files:** Create `scripts/fetch-libass.sh`, `scripts/fetch-ass-fonts.sh`, `fixtures/ass/fonts/` (fonts plus `LICENSE-DejaVu.txt`, `index.txt`), `tools/ass-trace/Dockerfile`, `tools/ass-trace/trace.patch`, `tools/ass-trace/ass_trace.c`, `tools/ass-trace/build.sh`, `tools/ass-trace/run.sh`, `tools/ass-trace/golden.sh`, `tools/ass-trace/README.md`, `tests/ass-trace/format.ts`, `tests/ass-trace/png.ts`, `tests/ass-trace/run.ts`, `fixtures/ass/basic/basic.ass`, `fixtures/ass/basic/times.txt`, `tests/ass-trace/golden/basic.jsonl`, `tests/ass-trace/golden/basic/*.png`, `.github/workflows/ass-trace.yml`. Modify `package.json` (scripts), `.gitignore` (`tools/ass-trace/out/`), `vite.config.ts` (Vitest include `tests/ass-trace/**/*.test.ts`). Test: `tests/ass-trace/format.test.ts`, `tests/ass-trace/png.test.ts`.

**Interfaces (produces):**
```ts
// tests/ass-trace/format.ts: one JSON line per event shown per time, in libass's output order (layer, then input order)
export interface TraceGlyph { readonly x: number; readonly y: number; readonly adv: number; readonly ch: number }
export interface TraceRun {
  readonly text: string;                       // the run's characters, UTF-8
  readonly font: string;                       // matched face: "<family>|<file name>|<face index>"
  readonly size: number;                       // GlyphInfo.font_size
  readonly scale: readonly [number, number];   // scale_x, scale_y (after fix_glyph_scaling)
  readonly hspacing: number;
  readonly colors: readonly [string, string, string, string]; // c[0..3] as 8-digit hex RRGGBBAA, fade applied
  readonly border: readonly [number, number];  // border_x, border_y
  readonly shadow: readonly [number, number];
  readonly blur: number;
  readonly be: number;
  readonly rot: readonly [number, number, number];   // frx, fry, frz (radians)
  readonly shear: readonly [number, number];         // fax, fay
  readonly borderStyle: number;
  readonly flags: number;                            // DECO_UNDERLINE | DECO_STRIKETHROUGH | DECO_ROTATE
  readonly bold: number;
  readonly italic: number;
  readonly karaoke: readonly [type: number, timing: number]; // effect_type, effect_timing (after ass_process_karaoke_effects)
  readonly drawing: boolean;
  readonly matrix: readonly number[];                // 9 numbers, row-major: calc_transform_matrix's m for the run's first glyph
  readonly glyphs: readonly TraceGlyph[];            // device position (device_x + pos.x/64, device_y + pos.y/64) and advance/64
}
export interface TraceEvent {
  readonly t: number;              // ms
  readonly event: number;          // index in the track (ReadOrder order of the file)
  readonly layer: number;
  readonly box: readonly [left: number, top: number, width: number, height: number]; // EventImages after fix_collisions
  readonly lines: number;
  readonly clip: readonly [x0: number, y0: number, x1: number, y1: number] | { readonly vector: string; readonly inverse: boolean };
  readonly runs: readonly TraceRun[];
}
export function parseTrace(jsonl: string): TraceEvent[];
export function formatTrace(events: readonly TraceEvent[]): string; // one line per event, keys in the order above, numbers rounded to 1/64

// tests/ass-trace/png.ts (RGBA8, no interlace; only what the harness writes and our page produces)
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array;
export function decodePng(bytes: Uint8Array): { width: number; height: number; rgba: Uint8Array };
```

- [ ] **Step 1: Fetch scripts.** `scripts/fetch-libass.sh` mirrors `scripts/fetch-libbluray.sh`: `COMMIT=4a05d8127f525943ebf45fdc6497c9e665947f0d`, `DEST=.cache/libass`, clone `https://github.com/libass/libass.git`, check out the commit, exit early when already there. `scripts/fetch-ass-fonts.sh` downloads `https://github.com/dejavu-fonts/dejavu-fonts/releases/download/version_2_37/dejavu-fonts-ttf-2.37.tar.bz2`, checks its SHA-256 (`fa9ca4d13871dd122f61258a80d01751d603b4d3ee14095d65453b4e846e17d7`, verified 2026-10-15; if the download differs, stop and ask, never update the hash blindly), and copies `DejaVuSans.ttf`, `DejaVuSans-Bold.ttf`, `DejaVuSans-Oblique.ttf`, `DejaVuSerif.ttf`, `DejaVuSansMono.ttf` and `LICENSE` (as `LICENSE-DejaVu.txt`) into `fixtures/ass/fonts/`, then writes `index.txt` listing the font files one per line. Run both; commit the fonts.

- [ ] **Step 2: Dockerfile.** Same base image digest as `tools/vm-trace/Dockerfile`. Install `build-essential meson ninja-build pkg-config git ca-certificates libfreetype-dev libharfbuzz-dev libfribidi-dev zlib1g-dev`. Clone libass at the commit, apply `trace.patch`, then:
  ```
  meson setup build --buildtype=release --default-library=static -Dfontconfig=disabled -Ddirectwrite=disabled \
    -Dcoretext=disabled -Drequire-system-font-provider=false -Dasm=disabled -Dlibunibreak=disabled -Dtest=false
  ninja -C build
  ```
  Build `ass_trace.c` statically against `build/libass/libass.a` and `pkg-config --static --libs freetype2 harfbuzz fribidi`, with `-Wall -Wextra -Werror`.

- [ ] **Step 3: `trace.patch`.** Against `libass/ass_render.c` and `ass_render.h`:
  - Add `char *trace;` to `EventImages` and a global `void (*ass_trace_sink)(const char *line)` (declared `extern` in `ass_render.h`, NULL by default, so an unpatched path is unchanged).
  - At the end of `ass_render_event`, after `render_and_combine_glyphs` and the `event_images` fields are set, when `ass_trace_sink` is set: build the JSON object of `TraceEvent` without `t` and `box` into a malloc'd string in `event_images->trace`. Runs are split exactly where `render_and_combine_glyphs` starts a new combined bitmap (`starts_new_run`); glyph positions are `device_x + pos.x / 64.0` and `device_y + pos.y / 64.0` (before `par_scale_x`, which is 1 here); the run's matrix is the `m` that `calc_transform_matrix` produces for its first glyph; the vector clip is the original drawing text from `state->clip_drawing_text` (store a copy when `parse_vector_clip` runs).
  - In `ass_render_frame`, after the `fix_collisions` loop, for each `priv->eimg[i]` with a trace: call `ass_trace_sink` with `{"t":<now>,"event":<event - track->events>,"layer":..,"box":[left,top,width,height],` + the stored object; free it. Doubles print with `%.6f`.
  The patch must apply with `patch -p1` and change nothing else.

- [ ] **Step 4: `ass_trace.c`.** Usage: `ass_trace <file.ass> <fonts dir> <times file> <out dir>`. It creates the library, sets `ass_set_fonts_dir` to the fonts dir and `ass_set_extract_fonts(lib, 1)`, reads the track with `ass_read_file(lib, path, "UTF-8")`, creates the renderer with `ass_set_frame_size(1920,1080)`, `ass_set_storage_size(1920,1080)`, `ass_set_font_scale(1)`, `ass_set_hinting(ASS_HINTING_NONE)`, `ass_set_shaper(ASS_SHAPING_COMPLEX)`, `ass_set_use_margins(0)`, `ass_set_line_position(0)`, `ass_set_fonts(r, "<fonts dir>/DejaVuSans.ttf", "DejaVu Sans", ASS_FONTPROVIDER_NONE, NULL, 0)`; selective style override stays off and no colour conversion is applied. If the fixture folder has a `storage.txt` (`<w> <h>`), it calls `ass_set_storage_size` with it instead. For each time (ms, one per line): set `ass_trace_sink` to print to stdout with a trailing newline, call `ass_render_frame`, blend the image list onto a 1920×1080 `#808080` opaque RGBA buffer (`alpha = (255 - (color & 0xFF)) * mask / 255`, colour `color >> 8`, standard over), and write `<out dir>/<ms>.rgba` (raw). Exit non-zero on any failure.

- [ ] **Step 5: `build.sh`, `run.sh`, `golden.sh`** (as in `tools/vm-trace/`):
  - `build.sh`: `docker build -t bluray-web-ass-trace tools/ass-trace`.
  - `run.sh <file.ass> <fonts dir> <times file> <out dir>`: runs the image with the inputs mounted read-only and the out dir mounted, prints the trace to stdout.
  - `golden.sh`: for every `fixtures/ass/<name>/<name>.ass` with a `times.txt`: run into `tools/ass-trace/out/<name>/`, write `tests/ass-trace/golden/<name>.jsonl` via `npx tsx tests/ass-trace/run.ts normalize` (parses and re-formats with `formatTrace`), convert each `.rgba` to `tests/ass-trace/golden/<name>/<ms>.png` with `encodePng`.
  - `package.json`: `"ass-trace:build": "tools/ass-trace/build.sh"`, `"ass-trace:golden": "tools/ass-trace/golden.sh"`, `"ass-trace": "tsx tests/ass-trace/run.ts"` (run on any file: `npm run ass-trace -- <file.ass> <fonts dir> <times file>` writes the JSONL and PNGs to `tools/ass-trace/out/<name>/`).

- [ ] **Step 6: Write the failing tests** `tests/ass-trace/png.test.ts` and `format.test.ts`:
  ```ts
  import { describe, expect, it } from 'vitest';
  import { decodePng, encodePng } from './png';
  import type { AssTracePage } from './page/types';

  describe('png', () => {
    it('round-trips RGBA exactly', () => {
      const rgba = new Uint8Array(3 * 2 * 4).map((_, i) => (i * 37) & 0xff);
      const out = decodePng(encodePng(3, 2, rgba));
      expect(out.width).toBe(3);
      expect(out.height).toBe(2);
      expect([...out.rgba]).toEqual([...rgba]);
    });
    it('rejects anything that is not 8-bit RGBA', () => {
      const png = encodePng(1, 1, new Uint8Array(4));
      png[25] = 2; // colour type RGB
      expect(() => decodePng(png)).toThrow(/RGBA/);
    });
  });
  ```
  ```ts
  import { readFileSync } from 'node:fs';
  import { describe, expect, it } from 'vitest';
  import { formatTrace, parseTrace } from './format';

  describe('trace format', () => {
    it('re-formats the committed golden byte for byte', () => {
      const text = readFileSync('tests/ass-trace/golden/basic.jsonl', 'utf8');
      expect(formatTrace(parseTrace(text))).toBe(text);
    });
    it('rounds numbers to 1/64', () => {
      const line = formatTrace([{ t: 0, event: 0, layer: 0, box: [0.0001, 1, 2, 3], lines: 1, clip: [0, 0, 1920, 1080], runs: [] }]);
      expect(JSON.parse(line).box[0]).toBe(0);
    });
  });
  ```
  `encodePng` uses `node:zlib` `deflateSync` and `crc32`, filter 0 on every row; `decodePng` accepts colour type 6, bit depth 8, filters 0–4.

- [ ] **Step 7: The first fixture.** `fixtures/ass/basic/basic.ass`: PlayRes 1920×1080, WrapStyle 0, ScaledBorderAndShadow yes, one style `Default` (DejaVu Sans 64, white, black outline 3, shadow 2, alignment 2, margins 40/40/50), three Dialogue lines: a plain two-word line from 0:00:01.00 to 0:00:03.00, a line with `\N` overlapping it (collision), and `{\an8\b1}Top bold` from 0:00:02.00 to 0:00:04.00. `times.txt`: `1000`, `2000`, `2500`, `3500`.

- [ ] **Step 8: Build, generate, run the tests.**
  Run: `npm run ass-trace:build && npm run ass-trace:golden && npx vitest run tests/ass-trace`
  Expected: golden JSONL with 1, 3, 3, 1 lines for the four times and four PNGs; tests PASS. Run `npm run ass-trace:golden` again: `git status` shows no change (deterministic).

- [ ] **Step 9: CI.** `.github/workflows/ass-trace.yml` copies `vm-trace.yml`: triggers on `tools/ass-trace/**`, `fixtures/ass/**`, `tests/ass-trace/golden/**`, the workflow file; the job runs `npm ci`, `npm run ass-trace:build && npm run ass-trace:golden && git diff --exit-code tests/ass-trace/golden/`. `tools/ass-trace/README.md` describes the commands, the trace format (pointing at `format.ts`) and that goldens are never edited by hand.

- [ ] **Step 10: Commit.**
  ```bash
  git add scripts/fetch-libass.sh scripts/fetch-ass-fonts.sh fixtures/ass tools/ass-trace tests/ass-trace .github/workflows/ass-trace.yml package.json .gitignore vite.config.ts
  git commit -m "test(ass): libass trace harness with layout traces and golden images"
  ```

### Task 2: Layout and pixel comparers

**Files:** Create `tests/ass-trace/compare.ts`, `tests/ass-trace/pixels.ts`. Modify `package.json` (dev dependency `pixelmatch@7.1.0`). Test: `tests/ass-trace/compare.test.ts`, `tests/ass-trace/pixels.test.ts`.

**Interfaces:**
- Consumes: `TraceEvent`, `TraceRun` (Task 1).
- Produces:
```ts
// compare.ts
export interface TraceDiff { readonly t: number; readonly event: number; readonly path: string; readonly expected: unknown; readonly actual: unknown }
/** Discrete fields must be equal; positions, sizes, boxes and matrices within `tolerance` px; the `font` of a run whose expected family is missing from `available` is compared on the family only. */
export function compareTraces(expected: readonly TraceEvent[], actual: readonly TraceEvent[], opts: { readonly tolerance: number; readonly missingFamilies: ReadonlySet<string> }): TraceDiff[];
export function formatDiffs(diffs: readonly TraceDiff[], limit?: number): string;
// pixels.ts
export interface PixelResult { readonly differing: number; readonly budget: number; readonly pass: boolean; readonly diff: Uint8Array }
/** pixelmatch with threshold 0.1, includeAA false; budget = max(64, 0.005 × total event box area clipped to the frame). */
export function comparePixels(expected: Uint8Array, actual: Uint8Array, width: number, height: number, boxes: readonly (readonly [number, number, number, number])[]): PixelResult;
```

Discrete fields: `event`, `layer`, `lines`, run count, `text`, `font` (whole string, or family only per the rule above), `borderStyle`, `flags`, `bold`, `italic`, `karaoke[0]`, `drawing`, glyph count and `ch`, clip kind and inverse flag. Toleranced: `box`, glyph `x`/`y`/`adv`, numeric clip coordinates, `size`, `scale`, `hspacing`, `border`, `shadow`, `blur`, `be` (exact), `rot`/`shear` (1e-6), `karaoke[1]` (1 unit), `matrix` (1e-4 relative), colours exact. Events are matched by `(t, event)`; a missing or extra event is a diff with path `''`.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  import { describe, expect, it } from 'vitest';
  import { compareTraces } from './compare';
  import type { TraceEvent } from './format';

  const run = { text: 'Hi', font: 'DejaVu Sans|DejaVuSans.ttf|0', size: 64, scale: [1, 1], hspacing: 0, colors: ['FFFFFF00', '0000FF00', '00000000', '00000080'], border: [3, 3], shadow: [2, 2], blur: 0, be: 0, rot: [0, 0, 0], shear: [0, 0], borderStyle: 1, flags: 0, bold: 0, italic: 0, karaoke: [0, 0], drawing: false, matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1], glyphs: [{ x: 900, y: 1000, adv: 40, ch: 72 }, { x: 940, y: 1000, adv: 18, ch: 105 }] } as const;
  const ev = (over: Partial<TraceEvent> = {}): TraceEvent => ({ t: 1000, event: 0, layer: 0, box: [890, 940, 80, 80], lines: 1, clip: [0, 0, 1920, 1080], runs: [run], ...over });
  const opts = { tolerance: 0.5, missingFamilies: new Set<string>() };

  describe('compareTraces', () => {
    it('accepts positions within the tolerance', () => {
      const moved = ev({ runs: [{ ...run, glyphs: [{ ...run.glyphs[0], x: 900.4 }, run.glyphs[1]] }] });
      expect(compareTraces([ev()], [moved], opts)).toEqual([]);
    });
    it('reports a position outside it with its path', () => {
      const moved = ev({ runs: [{ ...run, glyphs: [{ ...run.glyphs[0], x: 901 }, run.glyphs[1]] }] });
      expect(compareTraces([ev()], [moved], opts).map((d) => d.path)).toEqual(['runs[0].glyphs[0].x']);
    });
    it('requires discrete fields to match exactly', () => {
      expect(compareTraces([ev()], [ev({ lines: 2 })], opts).map((d) => d.path)).toEqual(['lines']);
    });
    it('reports missing and extra events', () => {
      expect(compareTraces([ev()], [ev({ event: 1 })], opts)).toHaveLength(2);
    });
    it('compares only the family of a run drawn in a missing family, and skips its positions', () => {
      const actual = ev({ runs: [{ ...run, font: 'DejaVu Sans|fallback|0', glyphs: [{ ...run.glyphs[0], x: 950 }, run.glyphs[1]] }] });
      const expected = ev({ runs: [{ ...run, font: 'Fancy|DejaVuSans.ttf|0' }] });
      expect(compareTraces([expected], [actual], { tolerance: 0.5, missingFamilies: new Set(['fancy']) })).toEqual([]);
    });
  });
  ```
  `pixels.test.ts` (a 256×256 grey image pair, one with a white square drawn in):
  - identical images: `differing` 0, pass;
  - a 10×10 square with one 32×32 box: `differing` 100, budget 64 (the floor), fail;
  - a 9×9 square with boxes totalling 20 000 px²: `differing` 81, budget 100, pass.

- [ ] **Step 2: Run them to see them fail.** `npx vitest run tests/ass-trace/compare.test.ts tests/ass-trace/pixels.test.ts`: FAIL (modules missing).
- [ ] **Step 3: Implement** `compare.ts` and `pixels.ts` (`npm i -D pixelmatch@7.1.0`).
- [ ] **Step 4: Run them to see them pass.**
- [ ] **Step 5: Commit.** `git commit -m "test(ass): layout and pixel comparers for libass traces"`

---

## Phase B: parsing and fonts

### Task 3: The ASS parser

**Files:** Create `src/engine/ass/types.ts`, `src/engine/ass/parse.ts`. Test: `src/engine/ass/parse.test.ts`.

**Port (`ass.c`, `ass_utils.c`, `ass_strtod.c`):** `set_default_style`, `string2timecode`, `read_digits`, `mystrtou32_modulo`, `parse_int_header`, `parse_color_header`, `parse_bool`, `parse_ycbcr_matrix`, `next_token`, `process_event_tail`, `set_style_alpha`, `process_style` (named `processStyle`), `format_line_compare`, `custom_format_line_compatibility`, `process_styles_line`, `parse_script_type`, `process_info_line`, `event_format_fallback`, `detect_legacy_conv_subs`, `process_events_line`, `decode_chars`, `decode_font`, `process_fonts_line`, `process_line`, `process_text`, `parse_memory`'s post-processing (`ass_lazy_track_init`: PlayResX/Y defaults and LayoutRes), `check_duplicate_event` (ReadOrder duplicates), `ass_lookup_style`, `ass_strtod` (as `assStrtod`, keeping its exact rounding and partial-parse behaviour). Strings are JS strings, not bytes; the `ass_utf8_get_char` users become code-point iteration.

**Interfaces (produces):**
```ts
// types.ts (field names follow ASS_Style / ASS_Event / ASS_Track)
export const enum YCbCrMatrix { Default = 0, Unknown, None, Bt601Tv, Bt601Pc, Bt709Tv, Bt709Pc, Smpte240mTv, Smpte240mPc, FccTv, FccPc }
export interface AssStyle {
  readonly name: string; readonly fontName: string; readonly fontSize: number;
  readonly primaryColour: number; readonly secondaryColour: number; readonly outlineColour: number; readonly backColour: number;
  readonly bold: number; readonly italic: number; readonly underline: number; readonly strikeOut: number;
  readonly scaleX: number; readonly scaleY: number;           // fractions (libass divides by 100)
  readonly spacing: number; readonly angle: number; readonly borderStyle: number;
  readonly outline: number; readonly shadow: number; readonly alignment: number;  // libass's internal legacy (\a) numbering, as process_style stores it
  readonly marginL: number; readonly marginR: number; readonly marginV: number;
  readonly encoding: number; readonly treatFontNameAsPattern: number; readonly blur: number; readonly justify: number;
}
export interface AssEvent {
  readonly readOrder: number; readonly layer: number; readonly start: number; readonly duration: number; // ms
  readonly style: number; readonly name: string; readonly marginL: number; readonly marginR: number; readonly marginV: number;
  readonly effect: string; readonly text: string;
}
export interface AssTrack {
  readonly trackType: 'ass' | 'ssa' | 'unknown';
  readonly playResX: number; readonly playResY: number; readonly layoutResX: number; readonly layoutResY: number;
  readonly wrapStyle: number; readonly scaledBorderAndShadow: boolean; readonly kerning: boolean;
  readonly ycbcrMatrix: YCbCrMatrix; readonly language: string | null;
  readonly styles: readonly AssStyle[];     // index 0 is libass's built-in "Default"
  readonly defaultStyle: number;
  readonly events: readonly AssEvent[];     // in file order
  readonly fonts: readonly { readonly name: string; readonly bytes: Uint8Array }[];
  readonly skippedLines: number;            // malformed Style/Dialogue lines
  readonly eventLines: number;              // Dialogue lines seen
}
// parse.ts
export function parseAss(text: string): AssTrack;
/** A `[Script Info]`, `[V4+ Styles]` or `[V4 Styles]` section header within the first 4 KiB, after a BOM and blank lines. */
export function looksLikeAss(text: string): boolean;
export function lookupStyle(track: AssTrack, name: string): number; // ass_lookup_style
```

- [ ] **Step 1: Write the failing tests** (`src/engine/ass/parse.test.ts`):
  ```ts
  import { describe, expect, it } from 'vitest';
  import { looksLikeAss, lookupStyle, parseAss } from './parse';

  const HEADER = `[Script Info]
  ScriptType: v4.00+
  PlayResX: 1280
  PlayResY: 720
  WrapStyle: 2
  ScaledBorderAndShadow: yes
  YCbCr Matrix: TV.709

  [V4+ Styles]
  Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
  Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,110,0,0,1,2.5,1,2,10,20,30,1
  `.replace(/^  /gm, '');
  const EVENTS = (...lines: string[]) => `\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${lines.join('\n')}\n`;

  describe('parseAss', () => {
    it('reads script info, styles and events as libass does', () => {
      const t = parseAss(HEADER + EVENTS('Dialogue: 1,0:00:01.50,0:00:03.00,Default,Bob,0,0,0,,Hello, {\\b1}world'));
      expect([t.trackType, t.playResX, t.playResY, t.wrapStyle, t.scaledBorderAndShadow]).toEqual(['ass', 1280, 720, 2, true]);
      const s = t.styles[lookupStyle(t, 'Default')]!;
      expect([s.fontName, s.fontSize, s.primaryColour, s.backColour, s.bold, s.scaleY, s.outline]).toEqual(['Arial', 48, 0xffffff00, 0x00000080, 1, 1.1, 2.5]);
      expect(t.events).toEqual([{ readOrder: 0, layer: 1, start: 1500, duration: 1500, style: lookupStyle(t, 'Default'), name: 'Bob', marginL: 0, marginR: 0, marginV: 0, effect: '', text: 'Hello, {\\b1}world' }]);
    });
    it('defaults PlayRes like libass when it is missing (384×288, or 4:3 of the one given)', () => {
      expect([parseAss('[Script Info]\n').playResX, parseAss('[Script Info]\n').playResY]).toEqual([384, 288]);
      const onlyY = parseAss('[Script Info]\nPlayResY: 720\n');
      expect(onlyY.playResX).toBe(960);
    });
    it('honours a reordered Format line and tolerates missing trailing fields', () => {
      const t = parseAss(HEADER + '\n[Events]\nFormat: Start, End, Text\nDialogue: 0:00:00.00,0:00:01.00,a,b\n');
      expect(t.events[0]!.text).toBe('a,b');
      expect(t.events[0]!.style).toBe(t.defaultStyle);
    });
    it('falls back to the default style for an unknown style name', () => {
      const t = parseAss(HEADER + EVENTS('Dialogue: 0,0:00:00.00,0:00:01.00,Nope,,0,0,0,,x'));
      expect(t.events[0]!.style).toBe(lookupStyle(t, 'Nope'));
    });
    it('stores alignment in legacy numbering: numpad2align for ASS, SSA kept with VSFilter fixes', () => {
      expect(parseAss(HEADER).styles.at(-1)!.alignment).toBe(2);
      const top = parseAss(HEADER.replace(',1,2.5,1,2,10,', ',1,2.5,1,8,10,'));
      expect(top.styles.at(-1)!.alignment).toBe(6);
      const ssa = `[Script Info]\nScriptType: v4.00\n\n[V4 Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, TertiaryColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, AlphaLevel, Encoding\nStyle: S,Arial,20,16777215,255,0,0,0,0,1,2,0,6,10,10,10,0,0\n`;
      expect(parseAss(ssa).styles.at(-1)!.alignment).toBe(6); // SSA 6 (top centre) is already legacy
    });
    it('decodes uuencoded [Fonts] entries', () => {
      const body = 'fontname: a.ttf\n' + uuencodeLikeAss(new Uint8Array([0, 1, 2, 3, 254, 255])) + '\n';
      expect([...parseAss(HEADER + '\n[Fonts]\n' + body + EVENTS()).fonts[0]!.bytes]).toEqual([0, 1, 2, 3, 254, 255]);
    });
    it('counts malformed lines and skips comments and other event types', () => {
      const t = parseAss(HEADER + EVENTS('Dialogue: garbage', 'Comment: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,c', '; note', 'Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,ok'));
      expect(t.events.map((e) => e.text)).toEqual(['ok']);
      expect([t.eventLines, t.skippedLines]).toEqual([2, 1]);
    });
    it('parses 50 000 events in well under 2 s', () => {
      const lines = Array.from({ length: 50_000 }, (_, i) => `Dialogue: 0,0:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:00.00,9:00:00.00,Default,,0,0,0,,line ${i}`);
      const t0 = performance.now();
      expect(parseAss(HEADER + EVENTS(...lines)).events).toHaveLength(50_000);
      expect(performance.now() - t0).toBeLessThan(2000);
    });
  });

  describe('looksLikeAss', () => {
    it('finds the section headers after a BOM and blank lines, not SRT', () => {
      expect(looksLikeAss('﻿\n\n[Script Info]\n')).toBe(true);
      expect(looksLikeAss('[V4+ Styles]\n')).toBe(true);
      expect(looksLikeAss('1\n00:00:01,000 --> 00:00:02,000\nHi\n')).toBe(false);
    });
  });

  /** The [Fonts] encoding (decode_chars): 6 bits per char, offset 33, 80-char lines. */
  function uuencodeLikeAss(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
      const chars = [18, 12, 6, 0].map((s) => String.fromCharCode(((n >> s) & 63) + 33));
      out += chars.slice(0, Math.min(4, bytes.length - i + 1)).join('');
    }
    return out.match(/.{1,80}/g)!.join('\n');
  }
  ```
  Check every expected value above against the C before relying on it (in particular the 4:3 default, the SSA alignment conversion and the unknown-style fallback); if libass disagrees, libass wins and the test changes.
- [ ] **Step 2: Run to see them fail.** `npx vitest run src/engine/ass/parse.test.ts`.
- [ ] **Step 3: Port.** `parseAss` normalizes line endings, strips a BOM, and runs `process_text` line by line. Event times use `string2timecode`. `process_events_line` keeps `Dialogue` only (`Comment`, `Picture`, `Sound`, `Movie`, `Command` are skipped, not counted as malformed).
- [ ] **Step 4: Run to see them pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat(ass): ASS parser ported from libass"`

### Task 4: Font tables

**Files:** Create `src/engine/ass/font-tables.ts`. Test: `src/engine/ass/font-tables.test.ts` (reads `fixtures/ass/fonts/*.ttf`).

**Port (`ass_fontselect.c`, `ass_font.c`):** `get_font_info` (family, full and PostScript names; English names first, all name records of IDs 1, 4, 6, 16 kept as libass does), `ass_face_get_weight`, `fsSelection_to_style_flags`, `ass_face_get_style_flags`, `set_font_metrics` (the Win/typo/bbox rule), `ass_face_is_postscript` (CFF table present), `check_postscript`. FreeType is replaced by our own reader of the `name`, `OS/2`, `hhea`, `head`, `post`, `cmap` (formats 4 and 12) and `CFF ` tag presence, for `.ttf`, `.otf`, `.ttc` (every face of a collection) and `.woff` (tables inflated with `DecompressionStream('deflate')`, so `readFontFile` is async).

**Interfaces (produces):**
```ts
export interface FaceInfo {
  readonly file: string; readonly index: number;          // face index inside a collection
  readonly families: readonly string[];                   // name IDs 1 and 16, all languages, de-duplicated
  readonly fullNames: readonly string[];                  // name ID 4
  readonly postscriptName: string | null;                 // name ID 6
  readonly weight: number;                                // ass_face_get_weight
  readonly italic: boolean; readonly bold: boolean;       // style flags as libass derives them
  readonly isPostscript: boolean;
  readonly unitsPerEm: number;
  readonly ascender: number; readonly descender: number;  // after set_font_metrics, font units, descender negative
  readonly underlinePosition: number; readonly underlineThickness: number; // post
  readonly strikeoutPosition: number; readonly strikeoutSize: number;       // OS/2
  hasGlyph(codepoint: number): boolean;                   // cmap
}
export interface FontFile { readonly name: string; readonly bytes: Uint8Array; readonly faces: readonly FaceInfo[] }
/** Throws FontFileError for anything unreadable (bad magic, truncated tables, no name table). */
export function readFontFile(name: string, bytes: Uint8Array): Promise<FontFile>;
export class FontFileError extends Error {}
```

- [ ] **Step 1: Write the failing tests:**
  ```ts
  import { readFileSync } from 'node:fs';
  import { describe, expect, it } from 'vitest';
  import { FontFileError, readFontFile } from './font-tables';

  const load = (f: string) => readFontFile(f, new Uint8Array(readFileSync(`fixtures/ass/fonts/${f}`)));

  describe('readFontFile', () => {
    it('reads names, weight, style and GDI metrics from a TTF', async () => {
      const [face] = (await load('DejaVuSans-Bold.ttf')).faces;
      expect(face!.families).toContain('DejaVu Sans');
      expect(face!.postscriptName).toBe('DejaVuSans-Bold');
      expect([face!.weight, face!.bold, face!.italic, face!.isPostscript]).toEqual([700, true, false, false]);
      expect(face!.unitsPerEm).toBe(2048);
      expect(face!.ascender).toBeGreaterThan(0);
      expect(face!.descender).toBeLessThan(0);
    });
    it('answers cmap lookups', async () => {
      const [face] = (await load('DejaVuSans.ttf')).faces;
      expect(face!.hasGlyph(0x41)).toBe(true);
      expect(face!.hasGlyph(0x3042)).toBe(false); // あ
    });
    it('reads every face of a collection', async () => {
      const a = readFileSync('fixtures/ass/fonts/DejaVuSans.ttf');
      const b = readFileSync('fixtures/ass/fonts/DejaVuSerif.ttf');
      const file = await readFontFile('pair.ttc', buildTtc([a, b]));
      expect(file.faces.map((f) => [f.index, f.families[0]])).toEqual([[0, 'DejaVu Sans'], [1, 'DejaVu Serif']]);
    });
    it('rejects garbage with FontFileError', async () => {
      await expect(readFontFile('x.ttf', new Uint8Array(100))).rejects.toBeInstanceOf(FontFileError);
      await expect(readFontFile('x.ttf', new Uint8Array(readFileSync('fixtures/ass/fonts/DejaVuSans.ttf')).subarray(0, 200))).rejects.toBeInstanceOf(FontFileError);
    });
  });
  ```
  `buildTtc` (a test helper in the same file) writes a `ttcf` header pointing at two whole TTFs appended after it, with their table offsets rebased. Add a WOFF case by building a WOFF from `DejaVuSans.ttf` in the test with `node:zlib` `deflateSync` per table.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to see them pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat(ass): font name and metric tables"`

### Task 5: Font matching and loading

**Files:** Create `src/engine/ass/fonts.ts`. Test: `src/engine/ass/fonts.test.ts`.

**Port (`ass_fontselect.c`, `ass_font.c`):** `matches_family_name`, `matches_full_or_postscript_name`, `font_attributes_similarity`, `find_font` and `select_font` (embedded and user fonts as the only provider, then the default font as libass's fallback), `ass_font_select`, `check_glyph` (per-character fallback to another face of the same request when a glyph is missing, as `ass_font_get_index` / `add_face` do: the default font is tried), the `@` prefix (`ASS_FontDesc.vertical`), and the size rule of `ass_face_set_size` with `FT_SIZE_REQUEST_TYPE_REAL_DIM`: a requested size `s` is an em of `s × unitsPerEm / (ascender − descender)` pixels.

**Interfaces:**
- Consumes: `FaceInfo`, `FontFile`, `readFontFile` (Task 4).
- Produces:
```ts
export interface FontRequest { readonly family: string; readonly bold: number; readonly italic: number; readonly vertical: boolean } // ASS_FontDesc
export interface ResolvedFace {
  readonly face: FaceInfo;
  readonly cssFamily: string;         // the private family the FontFace is registered under, e.g. "assf-12"
  readonly synthBold: boolean;        // request.bold > face.weight + 150 (ass_font_get_glyph)
  readonly synthItalic: boolean;      // request.italic > 0 && !face.italic
  readonly fallback: boolean;         // no supplied face matched; the default font
}
/** Registers a face for drawing (FontFace + document/worker FontFaceSet in production; a fake in tests). */
export interface FontLoader { load(cssFamily: string, bytes: Uint8Array, faceIndex: number): Promise<void>; unload(cssFamily: string): void }
export class AssFonts {
  constructor(loader: FontLoader, defaultFont: FontFile);
  /** Adds font files (supplied or from [Fonts]); unreadable ones are returned by name, not thrown. */
  add(files: readonly { name: string; bytes: Uint8Array }[]): Promise<{ readonly unreadable: readonly string[] }>;
  /** select_font for a request; the same object for the same request. */
  resolve(req: FontRequest): ResolvedFace;
  /** check_glyph fallback: the face to draw `codepoint` with for this request. */
  faceFor(req: FontRequest, codepoint: number): ResolvedFace;
  /** Loads the FontFaces of every resolved face not loaded yet. Rendering waits for this. */
  ready(): Promise<void>;
  /** Families requested and not found, in first-request order, case-insensitively unique. */
  missingFamilies(): readonly string[];
  dispose(): void;
}
/** px em size for a requested ASS font size (ass_face_set_size, REAL_DIM). */
export function emSize(face: FaceInfo, size: number): number;
```
The default font is `DejaVuSans.ttf`, shipped with the app as `src/engine/ass/default-font.ttf` (copied from `fixtures/ass/fonts/`, its licence added to `src/engine/NOTICE`), and fetched by the worker once when the first ASS track loads (`new URL('./default-font.ttf', import.meta.url)`). It is the same face the harness falls back to, so a fallback run matches libass in position; the trace comparison still treats it as a missing family.

- [ ] **Step 1: Write the failing tests:**
  ```ts
  import { readFileSync } from 'node:fs';
  import { describe, expect, it } from 'vitest';
  import { readFontFile } from './font-tables';
  import { AssFonts, emSize, type FontLoader } from './fonts';

  const bytes = (f: string) => new Uint8Array(readFileSync(`fixtures/ass/fonts/${f}`));
  function fakeLoader() {
    const loaded: string[] = [];
    const loader: FontLoader = { load: async (family) => { loaded.push(family); }, unload: () => {} };
    return { loader, loaded };
  }
  async function fonts(...files: string[]) {
    const { loader, loaded } = fakeLoader();
    const f = new AssFonts(loader, await readFontFile('DejaVuSans.ttf', bytes('DejaVuSans.ttf')));
    await f.add(files.map((name) => ({ name, bytes: bytes(name) })));
    return { f, loaded };
  }
  const req = (family: string, bold = 0, italic = 0) => ({ family, bold, italic, vertical: false });

  describe('AssFonts', () => {
    it('matches family names case-insensitively and picks the closest weight', async () => {
      const { f } = await fonts('DejaVuSans.ttf', 'DejaVuSans-Bold.ttf');
      expect(f.resolve(req('dejavu sans', 700)).face.postscriptName).toBe('DejaVuSans-Bold');
      expect(f.resolve(req('DejaVu Sans', 400)).face.postscriptName).toBe('DejaVuSans');
    });
    it('matches full and PostScript names', async () => {
      const { f } = await fonts('DejaVuSans-Bold.ttf');
      expect(f.resolve(req('DejaVuSans-Bold')).fallback).toBe(false);
      expect(f.resolve(req('DejaVu Sans Bold')).fallback).toBe(false);
    });
    it('synthesizes bold and italic as libass does', async () => {
      const { f } = await fonts('DejaVuSans.ttf');
      expect(f.resolve(req('DejaVu Sans', 700, 1))).toMatchObject({ synthBold: true, synthItalic: true });
      expect(f.resolve(req('DejaVu Sans', 500))).toMatchObject({ synthBold: false });
    });
    it('falls back to the default font and reports each missing family once', async () => {
      const { f } = await fonts('DejaVuSerif.ttf');
      expect(f.resolve(req('Fancy')).fallback).toBe(true);
      f.resolve(req('FANCY'));
      f.resolve(req('Other'));
      expect(f.missingFamilies()).toEqual(['Fancy', 'Other']);
    });
    it('loads only the faces that were resolved', async () => {
      const { f, loaded } = await fonts('DejaVuSans.ttf', 'DejaVuSerif.ttf', 'DejaVuSansMono.ttf');
      f.resolve(req('DejaVu Serif'));
      await f.ready();
      expect(loaded).toHaveLength(1);
    });
    it('returns unreadable files by name', async () => {
      const { f } = await fonts();
      expect((await f.add([{ name: 'bad.ttf', bytes: new Uint8Array(10) }])).unreadable).toEqual(['bad.ttf']);
    });
    it('uses the default font for a glyph the matched face lacks', async () => {
      const { f } = await fonts('DejaVuSansMono.ttf');
      expect(f.faceFor(req('DejaVu Sans Mono'), 0x41).face.postscriptName).toBe('DejaVuSansMono');
    });
  });

  describe('emSize', () => {
    it('makes ascender + descender equal the requested size', async () => {
      const [face] = (await readFontFile('a.ttf', bytes('DejaVuSans.ttf'))).faces;
      const em = emSize(face!, 64);
      expect(((face!.ascender - face!.descender) * em) / face!.unitsPerEm).toBeCloseTo(64, 6);
    });
  });
  ```
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement.** `AssFonts` keeps a list of `FaceInfo`s (supplied first, then embedded, as libass registers embedded fonts as a provider), resolves with libass's scoring, caches by request, assigns `assf-<n>` families. The production `FontLoader` (`createFontFaceLoader(fontSet: FontFaceSet)`, in the same file) builds `new FontFace(cssFamily, bytes)` (for a collection face it first extracts that face into a standalone sfnt), awaits `load()`, and adds it to the set; `unload` deletes it.
- [ ] **Step 4: Run to see them pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat(ass): libass font matching with FontFace loading"`

---

## Phase C: tags and timing

### Task 6: Render state and override tags

**Files:** Create `src/engine/ass/state.ts`, `src/engine/ass/tags.ts`. Test: `src/engine/ass/tags.test.ts`.

**Port (`ass_render.c`, `ass_parse.c`, `ass_render.h`):** the `RenderContext` fields that tags change (as `RenderState` in `state.ts`), `ass_reset_render_context`, `init_render_context` (without the glyph arrays), `init_font_scale`, `handle_selective_style_overrides` (override disabled: returns the event's style, but keeps libass's `ScaledBorderAndShadow` and font-scale handling), `ass_update_font` (builds the `FontRequest`, including the `@` prefix), and from `ass_parse.c`: `argtoi32`, `argtod`, `push_arg`, `mystrcmp`, `dtoi32`, `calc_anim`, `calc_anim_int32`, `change_color`, `change_alpha`, `mult_alpha`, `ass_apply_fade`, `interpolate_alpha`, `parse_vector_clip` (stores the drawing text; Task 8 parses it), `parse_alpha_tag`, `parse_color_tag`, `lookup_style_strict`, `ass_parse_tags` (every tag, `\t` with nested animation `pwr`, `\r` with and without a style, `\move` and `\pos` exclusivity via `evt_type`, `\fad`/`\fade`, `\org`, `\clip`/`\iclip` rectangle and vector, `\p`, `\pbo`, `\q`, `\k \K \kf \ko \kt`, `\fe`, `\a` legacy alignment, `\an`), `ass_get_next_char` (`\N`, `\n` per WrapStyle 2, `\h`), and `ass_event_has_hard_overrides`.

**Interfaces (produces):**
```ts
// state.ts
export interface RenderState {           // RenderContext fields of ass_render.h, same meanings and units
  style: AssStyle; event: AssEvent; track: AssTrack;
  fontRequest: FontRequest; fontSize: number;
  hspacing: number; scaleX: number; scaleY: number;
  borderX: number; borderY: number; borderStyle: number; shadowX: number; shadowY: number;
  frx: number; fry: number; frz: number; fax: number; fay: number;
  be: number; blur: number; flags: number;          // DECO_UNDERLINE | DECO_STRIKETHROUGH | DECO_ROTATE
  c: [number, number, number, number];
  alignment: number; justify: number; wrapStyle: number;
  evtType: number;                                  // EVENT_NORMAL | EVENT_POSITIONED | ...
  posX: number; posY: number; orgX: number; orgY: number; haveOrigin: boolean;
  clipX0: number; clipY0: number; clipX1: number; clipY1: number; clipMode: number; // 0 none, 1 rect/vector, -1 inverse (libass clip_mode)
  clipDrawingText: string | null; clipDrawingScale: number;
  explicit: boolean; detectCollisions: boolean; fade: number;
  drawingScale: number; pbo: number;
  effectType: number; effectTiming: number; effectSkipTiming: number; resetEffect: boolean;
  bold: number; italic: number;
  // plus the renderer settings the C reads through state->renderer: frame/storage/layout sizes, font scale, screen scales
  readonly settings: RenderSettings;
}
export interface RenderSettings {
  readonly frameWidth: number; readonly frameHeight: number;       // the video rectangle in device px
  readonly storageWidth: number; readonly storageHeight: number;
  readonly fontScale: number;                                       // the user's size scale
  readonly parScaleX: number;                                       // 1 unless storage aspect differs
}
export function initRenderState(track: AssTrack, event: AssEvent, settings: RenderSettings): RenderState;
export function resetRenderState(s: RenderState, style: AssStyle | null): void;  // ass_reset_render_context
// tags.ts
/** ass_parse_tags over one override block (between the braces), at time `now` (ms from the event's start). */
export function parseTags(s: RenderState, block: string, pwr: number, nested: boolean, now: number): void;
/** ass_get_next_char: the next code point of the text after `i`, with \N → '\n' etc.; returns [codepoint, nextIndex]. */
export function nextChar(s: RenderState, text: string, i: number): readonly [number, number];
export function applyFade(color: number, fade: number): number;
export function interpolateAlpha(now: number, t1: number, t2: number, t3: number, t4: number, a1: number, a2: number, a3: number): number;
export function hasHardOverrides(text: string): boolean;
```

- [ ] **Step 1: Write the failing tests.** One `it` per behaviour below, each building a state with `initRenderState(parseAss(...), event, SETTINGS)` and calling `parseTags`:
  ```ts
  import { describe, expect, it } from 'vitest';
  import { parseAss } from './parse';
  import { initRenderState, type RenderSettings } from './state';
  import { applyFade, interpolateAlpha, parseTags } from './tags';

  const SETTINGS: RenderSettings = { frameWidth: 1920, frameHeight: 1080, storageWidth: 1920, storageHeight: 1080, fontScale: 1, parScaleX: 1 };
  const TRACK = parseAss('[Script Info]\nPlayResX: 1920\nPlayResY: 1080\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,DejaVu Sans,50,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1\nStyle: Alt,DejaVu Serif,30,&H0000FF00,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:10.00,Default,,0,0,0,,x\n');
  const state = () => initRenderState(TRACK, TRACK.events[0]!, SETTINGS);
  const at = (block: string, now = 0) => { const s = state(); parseTags(s, block, 1, false, now); return s; };

  describe('parseTags', () => {
    it('sets colours (BGR in the tag) and alphas', () => {
      const s = at('\\c&H0000FF&\\3a&H80&');
      expect(s.c[0]).toBe(0xff000000);
      expect(s.c[2] & 0xff).toBe(0x80);
    });
    it('animates with \\t and acceleration at the given time', () => {
      expect(at('\\t(0,1000,\\fs100)', 500).fontSize).toBeCloseTo(75);
      expect(at('\\t(0,1000,2,\\fs100)', 500).fontSize).toBeCloseTo(50 + 50 * 0.25);
      expect(at('\\t(\\fs100)', 10_000).fontSize).toBeCloseTo(100); // whole event duration
    });
    it('uses the first \\pos or \\move and ignores later ones', () => {
      const s = at('\\pos(10,20)\\pos(30,40)\\move(0,0,100,100)');
      expect([s.posX, s.posY]).toEqual([10, 20]);
    });
    it('interpolates \\move between t1 and t2', () => {
      const s = at('\\move(0,0,100,200,1000,2000)', 1500);
      expect([s.posX, s.posY]).toEqual([50, 100]);
    });
    it('computes \\fad and \\fade alpha', () => {
      expect(at('\\fad(1000,0)', 500).fade).toBe(interpolateAlpha(500, 0, 1000, 10_000, 10_000, 0xff, 0, 0));
      expect(applyFade(0xffffff00, 0x80) & 0xff).toBe(0x80);
    });
    it('resets to the line style or a named one with \\r', () => {
      expect(at('\\fs99\\r').fontSize).toBe(50);
      expect(at('\\rAlt').fontSize).toBe(30);
      expect(at('\\rNope').fontSize).toBe(50);
    });
    it('reads rectangle and vector clips, and \\iclip as inverse', () => {
      expect(at('\\clip(1,2,3,4)')).toMatchObject({ clipX0: 1, clipY0: 2, clipX1: 3, clipY1: 4, clipMode: 1 });
      expect(at('\\iclip(m 0 0 l 10 0 10 10)')).toMatchObject({ clipDrawingText: 'm 0 0 l 10 0 10 10', clipMode: -1 });
      expect(at('\\clip(1,2,3)').clipMode).toBe(0); // malformed: ignored
    });
    it('clamps hostile values as libass does', () => {
      expect(at('\\fs-5').fontSize).toBe(50);
      expect(Number.isFinite(at('\\bord1e400').borderX)).toBe(true);
    });
  });
  ```
  For each assertion, confirm the number in the C first (`\fs-5` resetting, `\bord` clamping, `\t` with no times) and adjust the expectation to libass's behaviour, never the port to the test.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Port.**
- [ ] **Step 4: Run to see them pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat(ass): override tags and animation from libass"`

### Task 7: Events into glyph infos, karaoke

**Files:** Create `src/engine/ass/events.ts`. Test: `src/engine/ass/events.test.ts`.

**Port (`ass_render.c`, `ass_parse.c`):** `parse_events` (walks the event text, runs `parseTags` on each `{…}`, `nextChar` on text, fills one `GlyphInfo` per character with a copy of the state's glyph-affecting fields; drawings become one glyph with `drawing_text`), `split_style_runs`, `ass_process_karaoke_effects` (needs the glyph positions, so it is exported and called by Task 9 after wrapping, at the same point as in `ass_render_event`), and the `\p` drawing-mode text collection.

**Interfaces (produces):**
```ts
export interface GlyphInfo {           // GlyphInfo of ass_render.h; layout fields are filled by Task 9
  symbol: number; skip: boolean; isTrimmedWhitespace: boolean;
  font: FontRequest; face: ResolvedFace | null; fontSize: number;
  drawingText: string | null; drawingScale: number; drawingPbo: number;
  linebreak: 0 | 1 | 2; startsNewRun: boolean;
  c: [number, number, number, number];
  effectType: number; effectTiming: number; effectSkipTiming: number; resetEffect: boolean;
  be: number; blur: number; shadowX: number; shadowY: number;
  frx: number; fry: number; frz: number; fax: number; fay: number;
  scaleX: number; scaleY: number; scaleFix: number;
  borderStyle: number; borderX: number; borderY: number; hspacing: number;
  italic: number; bold: number; flags: number; fade: number;
  // filled by layout
  posX: number; posY: number;          // 26.6 like libass, as numbers
  advanceX: number; advanceY: number; clusterAdvanceX: number;
  asc: number; desc: number;
  next: GlyphInfo | null;              // cluster continuation
}
export interface EventText { readonly glyphs: GlyphInfo[]; readonly state: RenderState }
/** parse_events: null for an event with no visible characters (libass returns false). */
export function parseEvent(track: AssTrack, event: AssEvent, settings: RenderSettings, fonts: AssFonts, now: number): EventText | null;
export function splitStyleRuns(text: EventText): void;
export function processKaraoke(text: EventText, now: number): void; // ass_process_karaoke_effects
```

- [ ] **Step 1: Write the failing tests:** an event `a{\c&H0000FF&}b` gives two glyphs with different `c[0]` and `startsNewRun` on `b`; `a\Nb` puts `linebreak` on `b`; `{\p1}m 0 0 l 10 0 10 10{\p0}x` gives a drawing glyph with that text then `x`; `{comment}` alone returns null; karaoke: `{\k50}ab{\k100}cd` at now = 600 ms after `processKaraoke` with fake positions marks `ab` as passed (`effectTiming` past) and `cd` as pending, as `ass_process_karaoke_effects` computes; `\kf` gets a sweep position in subpixels proportional to elapsed time over the syllable width. Write each as an `it` with exact expected numbers taken from the C.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Port.**
- [ ] **Step 4: Run to see them pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat(ass): event text into glyph runs, karaoke timing"`

---

## Phase D: layout

### Task 8: Drawings

**Files:** Create `src/engine/ass/drawing.ts`. Test: `src/engine/ass/drawing.test.ts`.

**Port (`ass_drawing.c`):** `drawing_tokenize`, `add_node`, `get_point`, `add_3_points`, `add_many_points`, `add_root_node`, `drawing_add_curve` (the b-spline to cubic Bézier conversion for `s`/`p`/`c`), `ass_drawing_parse` (scale `1 / 2^(scale-1)`, the cbox, closing contours). Output is a path command list (not `Path2D`, so Node tests run) plus the control box in drawing units.

**Interfaces (produces):**
```ts
export type PathCommand = readonly ['M', number, number] | readonly ['L', number, number] | readonly ['C', number, number, number, number, number, number] | readonly ['Z'];
export interface Drawing { readonly commands: readonly PathCommand[]; readonly cbox: readonly [x0: number, y0: number, x1: number, y1: number] | null }
/** ass_drawing_parse; null for text libass rejects. `scale` is the \p level. */
export function parseDrawing(text: string, scale: number): Drawing | null;
export function toPath2D(d: Drawing, PathCtor: typeof Path2D): Path2D; // used by raster only
```

- [ ] **Step 1: Write the failing tests:** `m 0 0 l 100 0 100 100` gives `M L L Z` with cbox `[0,0,100,100]`; `\p2` halves coordinates; `b` gives one `C`; `s 0 0 100 0 100 100 c` gives libass's cubic segments (compute the expected control points from `drawing_add_curve` by hand in the test comment); implicit repeated `l` points (`l 1 1 2 2`) give two `L`; garbage (`m x y`) returns libass's result (check: tokens stop at the first bad number); an empty string returns null.
- [ ] **Step 2–4:** fail, port, pass.
- [ ] **Step 5: Commit.** `git commit -m "feat(ass): drawing commands and b-splines"`

### Task 9: Text layout

**Files:** Create `src/engine/ass/measure.ts`, `src/engine/ass/layout.ts`. Test: `src/engine/ass/layout.test.ts`.

**Port (`ass_render.c`):** `x2scr_pos`, `x2scr_left`, `x2scr_right`, `x2scr_pos_scaled`, `y2scr_pos`, `y2scr`, `y2scr_top`, `y2scr_sub`, `ass_layout_res`, `fix_glyph_scaling`, `retrieve_glyphs` (advances from `GlyphMeasurer` instead of HarfBuzz/FreeType; ascender and descender from `FaceInfo` scaled by `emSize`; drawings from their cbox and `\pbo`; vertical `@` glyphs at or above `VERTICAL_LOWER_BOUND` (0x02F1) rotated with their advance as libass sets it), `preliminary_layout`, `measure_text_on_eol`, `measure_text`, `trim_whitespace`, `wrap_lines_naive` (the branch without `CONFIG_UNIBREAK`), `rewind_trailing_spaces`, `wrap_lines_rebalance`, `wrap_lines_smart`, `reorder_text` (left-to-right only; see Deviation 2), `align_lines`, `compute_string_bbox`, `apply_baseline_shear`, `get_base_point`, and the positioning block of `ass_render_event` from "calculate max length of a line" through "fix clip coordinates" (scrolling branches left out). Kerning comes with the browser's shaping; `track.kerning` false sets `fontKerning = 'none'`.

**Interfaces:**
- Consumes: `EventText`, `GlyphInfo`, `processKaraoke` (Task 7), `AssFonts`, `emSize` (Task 5).
- Produces:
```ts
// measure.ts
export interface GlyphMeasurer {
  /** Advances (px, at `emPx`) of each UTF-16 index range of `text` shaped as one run in `cssFamily`: cluster boundaries where the advance changes. */
  measure(cssFamily: string, emPx: number, text: string): { readonly clusters: readonly { readonly start: number; readonly end: number; readonly advance: number }[] };
}
/** ctx.measureText on prefixes (so kerning and ligatures are the browser's shaping); one OffscreenCanvas 2D context. */
export function createCanvasMeasurer(ctx: OffscreenCanvasRenderingContext2D): GlyphMeasurer;
/** For Node tests: every code point advances `ratio × emPx`. */
export function createFixedMeasurer(ratio: number): GlyphMeasurer;
// layout.ts
export interface LaidOutEvent {
  readonly text: EventText;           // glyphs with posX/posY (26.6), linebreaks, asc/desc
  readonly lines: readonly { readonly asc: number; readonly desc: number }[];
  readonly deviceX: number; readonly deviceY: number;
  readonly bbox: readonly [number, number, number, number];
  readonly height: number; readonly borderTop: number; readonly borderBottom: number; readonly borderX: number;
  readonly clip: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number; readonly mode: number; readonly drawing: string | null };
}
export function layoutEvent(text: EventText, measurer: GlyphMeasurer, now: number): LaidOutEvent;
```

- [ ] **Step 1: Write the failing tests** with `createFixedMeasurer(0.5)` and DejaVu Sans metrics (fonts loaded from `fixtures/ass/fonts` with a fake loader): a bottom-centre line is centred horizontally with its baseline at `PlayResY − MarginV − desc`; `\an7` top-left starts at `MarginL` with the first line's ascender below `MarginV`; `\pos(960,540)\an5` puts the bbox centre on 960,540; WrapStyle 0 breaks a 30-word line into two lines whose top line is the shorter or equal (libass smart wrapping), WrapStyle 1 breaks greedily, WrapStyle 2 does not break except at `\N`, WrapStyle 3 makes the lower line wider; `\h` never breaks; trailing spaces are trimmed; `\fax0.5` shifts the second line's glyphs by the shear of their baseline distance; event `MarginL/R/V` override the style's; PlayRes 640×360 scales positions by 3 to a 1920×1080 frame; LayoutRes 1440×1080 with storage 1920×1080 scales x as `ass_layout_res` says. Write each expected position as a number computed from the C formulas in a comment next to it.
- [ ] **Step 2–4:** fail, port, pass.
- [ ] **Step 5: Commit.** `git commit -m "feat(ass): libass text layout and wrapping"`

### Task 10: Transforms, collisions and the frame

**Files:** Create `src/engine/ass/transform.ts`, `src/engine/ass/collisions.ts`, `src/engine/ass/frame.ts`. Test: `transform.test.ts`, `collisions.test.ts`, `frame.test.ts` under `src/engine/ass/`.

**Port (`ass_render.c`):** `calculate_rotation_params`, `calc_transform_matrix` (3×3 projective with the 20000-unit camera distance, the `\org` handling, `fax`/`fay`, scales, the `par_scale_x` term), `quantize_transform`/`restore_transform` only as far as they change the matrix libass uses (we use the exact matrix; note this in a comment), the event box of `ass_render_event` (`event_images->top/height/left/width`, `border_top/bottom` from the max border and shadow of the event's glyphs), `ass_start_frame` (font scale, `get_render_priv` collision memory), `cmp_event_layer`, `overlap`, `cmp_rect_y0`, `shift_event`, `fit_rect`, `fix_collisions` (with `ASS_RenderPriv.top/height/left/width` memory of events already shown), and the `ass_render_frame` loop (active-event test `Start ≤ now < Start + Duration`, render, sort by layer, collisions per layer). `ass_detect_change` becomes `FrameLayout.equalTo`.

**Interfaces:**
- Consumes: `parseEvent`, `splitStyleRuns`, `processKaraoke` (Task 7), `layoutEvent` (Task 9).
- Produces:
```ts
// transform.ts
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];
export function transformMatrix(glyph: GlyphInfo, shift: { x: number; y: number }, scale: { x: number; y: number }, parScaleX: number): Mat3; // calc_transform_matrix
export function applyMat3(m: Mat3, x: number, y: number): readonly [number, number];
export function isAffine(m: Mat3): boolean;        // m[6] = m[7] = 0 and m[8] = 1 within 1e-12
// collisions.ts
export class CollisionMemory {                    // ASS_RenderPriv per event, keyed by event index
  clear(): void;
  fix(events: EventBox[]): void;                  // fix_collisions over one layer's events, shifting `top`
}
export interface EventBox { readonly event: AssEvent; readonly index: number; top: number; readonly height: number; readonly left: number; readonly width: number; readonly detectCollisions: boolean; shift: number }
// frame.ts
export interface FrameEvent { readonly index: number; readonly layout: LaidOutEvent; readonly box: EventBox; readonly animated: boolean }
export interface FrameLayout { readonly t: number; readonly events: readonly FrameEvent[]; equalTo(other: FrameLayout | null): boolean }
export class FrameBuilder {
  constructor(track: AssTrack, fonts: AssFonts, measurer: GlyphMeasurer);
  /** The events active at `t` (ms), laid out, ordered by layer then index, collisions fixed. */
  build(t: number, settings: RenderSettings): FrameLayout;
  /** On seek: forget collision memory (libass keeps it only while events stay on screen). */
  reset(): void;
}
```
`FrameBuilder` finds active events with an interval index (events sorted by start with a max-end segment tree, as `subs/srt.ts`'s `activeCues` does), not a scan. An event is `animated` when its text has `\t`, `\move` with distinct points, `\fad`/`\fade`, or karaoke tags (scan once per event, cached).

- [ ] **Step 1: Write the failing tests:**
  - `transform.test.ts`: identity for a plain glyph; `\frz90` around `\org(0,0)` maps (1,0) to (0,−1) (y down, libass's sign); `\frx` gives a non-affine matrix and `isAffine` false; `\fscx200` doubles x.
  - `collisions.test.ts`: two bottom events on one layer: the second is pushed up by the first's height; an event already shown keeps its position when a new one arrives (memory); `\pos` events are not moved; different layers do not collide; `clear()` forgets.
  - `frame.test.ts` (fixed measurer): at t inside two events of layers 1 and 0, `events` lists layer 0 first; an event ending at 2000 is not active at 2000; 50 000 events, `build` at 10 random times takes under 50 ms in total and touches only active ones (spy on `layoutEvent` call count).
- [ ] **Step 2–4:** fail, port, pass.
- [ ] **Step 5: Commit.** `git commit -m "feat(ass): transforms, collision handling and frame assembly"`

### Task 11: Layout traces in Chrome

**Files:** Create `src/engine/ass/trace.ts`, `tests/ass-trace/page/index.html`, `tests/ass-trace/page/page.ts`, `tests/ass-trace/layout.spec.ts`, `tests/ass-trace/fixtures.ts`, `playwright.ass.config.ts`, and the synthetic corpus under `fixtures/ass/` with goldens. Modify `package.json` (`"test:ass": "playwright test -c playwright.ass.config.ts"`), `.github/workflows/ci.yml` (run `npm run test:ass` after the E2E job's Chrome setup), `vitest`/`tsconfig` includes if needed.

**Interfaces:**
- Consumes: `FrameBuilder`, `FrameLayout`, `transformMatrix` (Task 10), `createCanvasMeasurer` (Task 9), `AssFonts`, `createFontFaceLoader` (Task 5), `parseAss` (Task 3), `TraceEvent`, `compareTraces` (Tasks 1–2).
- Produces:
```ts
// src/engine/ass/trace.ts (engine side, so the page and the player's debug path share it)
export function frameToTrace(frame: FrameLayout, fonts: AssFonts): TraceEvent[]; // same splitting into runs as render_and_combine_glyphs
// tests/ass-trace/page/types.ts (imported with `import type` by page.ts and the specs; page.ts sets window.assTrace)
export interface AssTracePage {
  /** Loads the script and fonts (URLs served by Vite), then lays out each time; returns trace lines and, when `pixels`, RGBA frames (base64) on #808080. */
  run(scriptUrl: string, fontUrls: readonly string[], times: readonly number[], pixels: boolean): Promise<{ trace: string; frames: readonly string[]; missingFamilies: readonly string[] }>;
}
// tests/ass-trace/fixtures.ts
export interface AssFixture { readonly name: string; readonly script: string; readonly fonts: readonly string[]; readonly times: readonly number[]; readonly golden: string }
export function syntheticFixtures(): AssFixture[];  // every fixtures/ass/<name>/ with times.txt; fonts from fixtures/ass/fonts/index.txt
```
`TraceEvent` lives in `tests/ass-trace/format.ts`; `trace.ts` imports only the type (`import type`), so the engine gains no runtime dependency on tests. `playwright.ass.config.ts`: `testDir: 'tests/ass-trace'`, `testMatch: /.*\.spec\.ts/`, `webServer: { command: 'npx vite --port 5174 --strictPort', url: 'http://localhost:5174/tests/ass-trace/page/index.html' }`, `use: { channel: 'chrome', baseURL: 'http://localhost:5174' }`.

The synthetic corpus (each `fixtures/ass/<name>/<name>.ass` plus `times.txt`, fonts from `fixtures/ass/fonts/`): `basic` (Task 1), `wrap` (WrapStyle 0–3 on long lines, `\N`, `\n`, `\h`, trailing spaces), `align` (`\an1`–`\an9`, margins, event margins, `\a` legacy), `pos-move` (`\pos`, `\move` at several times, `\org` + `\frz`), `transform` (`\fscx \fscy \fsp \frz \fax \fay`, `\frx`/`\fry` at 30° and 70°), `anim` (`\t` over size, colour, alpha, rotation and clip, with acceleration, nested), `fade` (`\fad`, `\fade` 7-argument form), `karaoke` (`\k \K \kf \ko` at several times), `clip` (rectangle, vector, `\iclip`, scaled `\clip(2,…)`), `drawing` (`\p1`–`\p3`, `\pbo`, b-splines, drawing mixed with text), `border` (`\bord \xbord \ybord \shad \xshad \yshad`, BorderStyle 3, `\be1`, `\be3`, `\blur2`, `\blur8`), `fonts` (bold/italic synthesis, PostScript name match, a missing family, an embedded font in `[Fonts]`), `collisions` (four overlapping bottom lines across two layers, at times when lines come and go), `anamorphic` (LayoutRes 1440×1080 with PlayRes 1920×1080; the harness sets storage 1440×1080 for this file only, through an optional `storage.txt`), `ssa` (v4 styles and SSA alignment). Each `times.txt` lists the start, middle and last frame of every event, plus every 100 ms through animations. Regenerate goldens with `npm run ass-trace:golden`.

- [ ] **Step 1: Write the corpus files and generate their goldens.** Commit them first, alone: `git commit -m "test(ass): synthetic ASS corpus with libass goldens"`.
- [ ] **Step 2: Write the failing spec** `tests/ass-trace/layout.spec.ts`:
  ```ts
  import { expect, test } from '@playwright/test';
  import { readFileSync } from 'node:fs';
  import { compareTraces, formatDiffs } from './compare';
  import { syntheticFixtures } from './fixtures';
  import { parseTrace } from './format';
  import type { AssTracePage } from './page/types';

  for (const fx of syntheticFixtures()) {
    test(`layout matches libass: ${fx.name}`, async ({ page }) => {
      await page.goto('/tests/ass-trace/page/index.html');
      const out = await page.evaluate(([s, f, t]) => (window as unknown as { assTrace: AssTracePage }).assTrace.run(s, f, t, false), [fx.script, fx.fonts, fx.times] as const);
      const diffs = compareTraces(parseTrace(readFileSync(fx.golden, 'utf8')), parseTrace(out.trace), { tolerance: 0.5, missingFamilies: new Set(out.missingFamilies.map((f) => f.toLowerCase())) });
      expect(diffs, formatDiffs(diffs, 20)).toEqual([]);
    });
  }
  ```
- [ ] **Step 3: Run it to see it fail.** `npm run test:ass -- layout`: FAIL (page missing).
- [ ] **Step 4: Write `trace.ts`, the page and the config.** Run again; every fixture that fails is a porting bug (or a measurement difference above 0.5 px): fix it in the port, rerun, until all pass. A difference that is the browser's shaping and not the port (Chrome and HarfBuzz-in-libass disagree on a kerning pair) is not hidden by raising the tolerance: record the fixture, glyph and amounts in the ledger and ask the user.
- [ ] **Step 5: Commit.** `git commit -m "test(ass): layout traces compared with libass in Chrome"`

---

## Phase E: raster

### Task 12: Drawing an event

**Files:** Create `src/engine/ass/raster.ts`. Test: `src/engine/ass/raster.test.ts`.

**Port (`ass_render.c`, `ass_bitmap.c`, `ass_blur.c`, `ass_font.c`):** the filter flags and run grouping of `render_and_combine_glyphs` (`FILTER_BORDER_STYLE_3`, `FILTER_NONZERO_BORDER`, `FILTER_NONZERO_SHADOW`, `FILTER_FILL_IN_SHADOW`, `FILTER_FILL_IN_BORDER`), the composition order and semantics of `ass_composite_construct` and `render_text` (shadow image from the border, or the fill when there is no border or `FILL_IN_SHADOW`; border with the fill cut out (`ass_fix_outline`) unless `FILL_IN_BORDER`; fill; colours with fade applied), `add_background` (BorderStyle 4), `quantize_blur`/`restore_blur` and `ass_synth_blur`'s σ (our `ctx.filter = blur(<σ px>)` uses the restored radius's σ), `be_blur_pre`/`be_blur_post` (`\be` as N passes of a 3×3 box filter: drawn on a small canvas, then N × `blur()` with σ = √(2/3) px per pass, the variance of libass's [1 2 1]/4 kernel in each direction), `blend_vector_clip` (vector clip as a canvas clip path; inverse with `'evenodd'` over the frame rectangle), the karaoke `\kf` split at `effect_timing` (clip the run left and right of the sweep x, primary and secondary colours), underline and strikeout bars from `FaceInfo` (`ass_get_glyph_outline`'s DECO handling), `ass_glyph_embolden` (stroke the fill with width `unitsPerEm × yScale / 64 / 64` px) and `ass_glyph_italicize` (shear by `0x0366A / 0x10000`).

Borders: `strokeText` (or `stroke(path)` for drawings) with `lineWidth = 2 × border`, `lineJoin = 'round'`, drawn under the fill; unequal `\xbord`/`\ybord` stroke in a coordinate system scaled by `(1, ybord/xbord)` around the glyph run. Each run is drawn with `setTransform` from its `Mat3` when `isAffine`, and through `warp.ts` (Task 13) otherwise.

**Interfaces:**
- Consumes: `FrameEvent`, `Mat3`, `isAffine` (Task 10), `parseDrawing`, `toPath2D` (Task 8), `ResolvedFace` (Task 5), `drawWarped` (Task 13).
- Produces:
```ts
export interface RasterContext { readonly ctx: OffscreenCanvasRenderingContext2D; readonly scratch: () => OffscreenCanvas; readonly Path2D: typeof Path2D }
/** Draws one laid-out event into ctx (device px, frame origin at 0,0), in libass's order. */
export function drawEvent(rc: RasterContext, ev: FrameEvent, frame: { readonly width: number; readonly height: number }): void;
```

- [ ] **Step 1: Write the failing tests** with a recording fake context (extend the `fakeCtx` pattern of `src/engine/subs/text-renderer.test.ts` with `setTransform`, `filter`, `clip`, `beginPath`, `rect`, `drawImage`, `globalAlpha`): for a run with border 3 and shadow 2, the calls are shadow stroke+fill at (+2,+2) in the back colour, then stroke with `lineWidth` 6 and round join in the outline colour, then fill in the primary colour; with primary alpha 0xFF and a border, the shadow includes the fill (`FILL_IN_SHADOW`); BorderStyle 3 draws a rectangle box for the border; `\blur2` sets `filter` to `blur(<σ>px)` with the σ from `restore_blur(quantize_blur(2))`; `\kf` at half progress draws the run twice with complementary clip rectangles; a vector `\iclip` builds an even-odd clip of frame rect plus path; fade alpha multiplies all colours; synthetic bold adds a stroke in the fill colour of the computed width.
- [ ] **Step 2–4:** fail, port, pass.
- [ ] **Step 5: Commit.** `git commit -m "feat(ass): draw events with libass compositing rules"`

### Task 13: Projective warp for `\frx`/`\fry`

**Files:** Create `src/engine/ass/warp.ts`. Test: `src/engine/ass/warp.test.ts`.

Original code. A glyph run with a non-affine `Mat3` is drawn untransformed (its border, shadow and fill composited as in Task 12) into a scratch canvas with a 2-px margin, then mapped to the frame by subdividing the source rectangle into an `n × n` grid of cells, each split into two triangles; each triangle is drawn with `drawImage` under the affine transform that maps its three source corners to their projected positions, clipped to the projected triangle (expanded by 0.5 px to hide seams). `n` is chosen so that the projective error inside a cell (estimated from the second derivative of the projection at the cell's corners) stays under 0.25 px, capped at 32.

**Interfaces (produces):**
```ts
export function triangleAffine(src: readonly [number, number][], dst: readonly [number, number][]): DOMMatrix2DInit; // a,b,c,d,e,f
export function gridSize(m: Mat3, width: number, height: number): number;
export function drawWarped(ctx: OffscreenCanvasRenderingContext2D, source: OffscreenCanvas, m: Mat3, originX: number, originY: number): void;
```

- [ ] **Step 1: Write the failing tests:** `triangleAffine` maps each source corner to its destination exactly (1e-9); `gridSize` is 1 for an affine matrix and grows with `\frx` angle (30° < 70°) and stays ≤ 32; over a 100×40 source with `\fry60`, the maximum distance between the projective map and the piecewise-affine map at 1000 random points is under 0.25 px for the chosen grid.
- [ ] **Step 2–4:** fail, implement, pass.
- [ ] **Step 5: Commit.** `git commit -m "feat(ass): projective warp for 3D rotation"`

### Task 14: `AssRenderer`

**Files:** Create `src/engine/ass/renderer.ts`. Modify `src/engine/render/compositor.ts` (`TextRendererLike` gains `changed` and `visible`), `src/engine/subs/text-renderer.ts` (implements them; `visible` replaces `Player.textCueVisible`'s use of `activeCues`). Test: `src/engine/ass/renderer.test.ts`.

**Interfaces:**
- Consumes: `FrameBuilder` (Task 10), `drawEvent` (Task 12), `AssFonts` (Task 5), `createCanvasMeasurer` (Task 9).
- Produces:
```ts
// compositor.ts
export interface TextRenderOptions { readonly offsetUs: number; readonly scale: number; readonly storage: { readonly width: number; readonly height: number } | null } // storage: the video's coded size
export interface TextRendererLike {
  render(ctx: OffscreenCanvasRenderingContext2D, timeUs: number, videoRect: Rect, opts: TextRenderOptions): number;
  changed(timeUs: number, opts: TextRenderOptions): boolean;
  visible(timeUs: number, opts: TextRenderOptions): boolean;
}
// renderer.ts
export interface AssRenderStats { readonly events: number; readonly animated: number; readonly renderMs: number; readonly overBudget: number }
export class AssRenderer implements TextRendererLike {
  constructor(track: AssTrack, fonts: AssFonts, deps: { readonly measurer: GlyphMeasurer; readonly createCanvas: (w: number, h: number) => OffscreenCanvas; readonly nowMs: () => number; readonly Path2D: typeof Path2D; readonly colorMatrix: 'video' | 'none' });
  render(ctx: OffscreenCanvasRenderingContext2D, timeUs: number, videoRect: Rect, opts: TextRenderOptions): number; // number of events drawn
  changed(timeUs: number, opts: TextRenderOptions): boolean;
  visible(timeUs: number, opts: TextRenderOptions): boolean;
  /** Seek or offset change: forget collision memory and the last frame. */
  reset(): void;
  /** New fonts were added: drop layout and bitmap caches. */
  fontsChanged(): void;
  stats(): AssRenderStats;
}
```
Behaviour: `t = round((timeUs − offsetUs) / 1000)`. `RenderSettings` come from `videoRect` (frame size) and `opts.storage` (`parScaleX` as libass's `ass_set_storage_size` and `ass_layout_res` derive it) and `opts.scale` (font scale). Static events are drawn once into an `ImageBitmap`-like scratch canvas cut to their box and cached (LRU, 64 entries) keyed by event index, frame size and scale; animated events are drawn directly every frame. `changed` is true when the active set changes, any active event is animated, or settings change. A backward jump of more than 1 s, or any forward jump over 1 s, calls `reset()` (a seek). `render` times itself with `nowMs` for `stats()`.

- [ ] **Step 1: Write the failing tests** (fake canvas factory recording `drawImage`/draw calls, fixed measurer, fake loader): a static event is drawn into a cache canvas once over 10 frames and then blitted; an event with `\move` is drawn every frame; `changed` is false between two times inside one static event and true across an event boundary, after a scale change, and on every frame while an animated event is active; a seek (time going back 5 s) clears collision memory (spy `FrameBuilder.reset`); the cache stays at 64 entries after 100 static events; the offset shifts which event is active; with `colorMatrix: 'video'` a `TV.601` script's pure red `&H0000FF&` is drawn as the BT.601→BT.709 converted colour (compute the expected RGB in the test from the matrix coefficients) and a `None` script's is untouched, while `'none'` never converts; `visible` matches `render`'s count > 0. Also update `text-renderer.test.ts` with `visible` for SRT (same results as `activeCues`).
- [ ] **Step 2–4:** fail, implement, pass.
- [ ] **Step 5: Commit.** `git commit -m "feat(ass): AssRenderer with static caching"`

### Task 15: Golden images in Chrome

**Files:** Create `tests/ass-trace/pixels.spec.ts`. Modify `tests/ass-trace/page/page.ts` (draw frames through `AssRenderer` onto a 1920×1080 canvas filled `#808080`).

- [ ] **Step 1: Write the failing spec:**
  ```ts
  import { expect, test } from '@playwright/test';
  import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
  import { syntheticFixtures } from './fixtures';
  import { parseTrace } from './format';
  import { comparePixels } from './pixels';
  import { decodePng, encodePng } from './png';
  import type { AssTracePage } from './page/types';

  for (const fx of syntheticFixtures()) {
    test(`pixels match libass: ${fx.name}`, async ({ page }) => {
      await page.goto('/tests/ass-trace/page/index.html');
      const out = await page.evaluate(([s, f, t]) => (window as unknown as { assTrace: AssTracePage }).assTrace.run(s, f, t, true), [fx.script, fx.fonts, fx.times] as const);
      const golden = parseTrace(readFileSync(fx.golden, 'utf8'));
      const failures: string[] = [];
      fx.times.forEach((t, i) => {
        const expected = decodePng(readFileSync(fx.golden.replace(/\.jsonl$/, `/${t}.png`)));
        const actual = Uint8Array.from(Buffer.from(out.frames[i]!, 'base64'));
        const boxes = golden.filter((e) => e.t === t && !out.missingFamilies.length).map((e) => e.box);
        const r = comparePixels(expected.rgba, actual, 1920, 1080, boxes);
        if (!r.pass) {
          const dir = `test-results/ass-pixels/${fx.name}`;
          mkdirSync(dir, { recursive: true });
          writeFileSync(`${dir}/${t}-actual.png`, encodePng(1920, 1080, actual));
          writeFileSync(`${dir}/${t}-diff.png`, encodePng(1920, 1080, r.diff));
          failures.push(`${t} ms: ${r.differing} px differ (budget ${r.budget})`);
        }
      });
      expect(failures).toEqual([]);
    });
  }
  ```
  (Frames of the `fonts` fixture whose events use a missing family are excluded from pixels by the `missingFamilies` rule; give that fixture's missing-family event its own times so the other frames are still compared.)
- [ ] **Step 2: Run** `npm run test:ass -- pixels`. Fix differences in `raster.ts` / `warp.ts` until every fixture passes. A frame that stays over budget for a rasterizer reason (stroker, blur kernel) after the port is right is recorded with its diff image in the ledger and reported to the user; the budget is never raised to pass.
- [ ] **Step 3: Commit.** `git commit -m "test(ass): golden images compared in Chrome"`

---

## Phase F: integration

### Task 16: Episode subtitle sets

**Files:** Create `src/engine/subs/text-set.ts`. Test: `src/engine/subs/text-set.test.ts`.

Original code (spec §3.5): which file of a set shows at a playlist time, at what local time, and the automatic placement. Pure: no renderer, no protocol.

**Interfaces (produces):**
```ts
export interface SetFile<R> { readonly name: string; readonly format: 'srt' | 'ass'; readonly cues: number; readonly renderer: R }
export interface Placement { readonly startUs: number | null; readonly offsetMs: number }
export const MIN_EPISODE_US = 5 * 60 * 1_000_000;
/** Play item starts lasting ≥ MIN_EPISODE_US; every item start when none does. Playlist time, sorted. */
export function episodeStarts(items: readonly { readonly startUs: number; readonly durationUs: number }[]): number[];
/** Name order with numeric collation (ep2 before ep10). */
export function sortByName<T extends { readonly name: string }>(files: readonly T[]): T[];
/** File n at episode start n when the counts match (placed: true); else the first file at 0 and the rest unplaced (placed: false). */
export function autoPlace(fileCount: number, starts: readonly number[]): { readonly placements: Placement[]; readonly placed: boolean };
export class TextSet<R> {
  constructor(files: readonly SetFile<R>[]);           // already sorted
  readonly files: readonly SetFile<R>[];
  /** Placements for a playlist: remembered ones, else autoPlace (its `placed` is returned so the player can notify). */
  usePlaylist(playlistId: string, starts: readonly number[]): { readonly placed: boolean };
  placements(): readonly Placement[];
  /** Placing a file at another file's start unplaces that other file. */
  setStart(file: number, startUs: number | null): void;
  setOffset(file: number, ms: number): void;              // clamped to ±10 minutes as today
  /** The file whose window [start, next placed start) contains `playlistUs`, and its local time (µs) after the offset; null when none. */
  at(playlistUs: number): { readonly file: number; readonly renderer: R; readonly localUs: number } | null;
  /** The next window boundary after `playlistUs` (so the player knows when the shown file changes), or null. */
  nextBoundary(playlistUs: number): number | null;
}
```

- [ ] **Step 1: Write the failing tests:**
  ```ts
  import { describe, expect, it } from 'vitest';
  import { autoPlace, episodeStarts, MIN_EPISODE_US, sortByName, TextSet } from './text-set';

  const MIN = 60_000_000;
  const file = (name: string) => ({ name, format: 'ass' as const, cues: 1, renderer: name });

  describe('episodeStarts', () => {
    it('keeps play items of at least five minutes', () => {
      expect(episodeStarts([{ startUs: 0, durationUs: 30_000_000 }, { startUs: 30_000_000, durationUs: 24 * MIN }, { startUs: 30_000_000 + 24 * MIN, durationUs: 24 * MIN }])).toEqual([30_000_000, 30_000_000 + 24 * MIN]);
    });
    it('uses every item when none is that long', () => {
      expect(episodeStarts([{ startUs: 0, durationUs: 2_000_000 }, { startUs: 2_000_000, durationUs: 2_000_000 }])).toEqual([0, 2_000_000]);
      expect(MIN_EPISODE_US).toBe(5 * MIN);
    });
  });

  describe('sortByName', () => {
    it('orders numbers numerically', () => {
      expect(sortByName([file('ep10.ass'), file('ep2.ass'), file('ep1.ass')]).map((f) => f.name)).toEqual(['ep1.ass', 'ep2.ass', 'ep10.ass']);
    });
  });

  describe('autoPlace', () => {
    it('places file n at start n when the counts match', () => {
      expect(autoPlace(2, [0, 24 * MIN])).toEqual({ placements: [{ startUs: 0, offsetMs: 0 }, { startUs: 24 * MIN, offsetMs: 0 }], placed: true });
    });
    it('places only the first file at 0 otherwise', () => {
      expect(autoPlace(3, [0, 24 * MIN])).toEqual({ placements: [{ startUs: 0, offsetMs: 0 }, { startUs: null, offsetMs: 0 }, { startUs: null, offsetMs: 0 }], placed: false });
    });
    it('treats one file as placed at the playlist start', () => {
      expect(autoPlace(1, [0, 24 * MIN]).placed).toBe(true);
    });
  });

  describe('TextSet', () => {
    const set = () => { const s = new TextSet([file('ep1'), file('ep2')]); s.usePlaylist('00000', [0, 24 * MIN]); return s; };
    it('shows each file in its window, with local time from its start', () => {
      const s = set();
      expect(s.at(MIN)).toEqual({ file: 0, renderer: 'ep1', localUs: MIN });
      expect(s.at(25 * MIN)).toEqual({ file: 1, renderer: 'ep2', localUs: MIN });
    });
    it('hides a file past the next start even if its events run longer', () => {
      expect(set().at(24 * MIN)!.file).toBe(1);
    });
    it('applies each file its own offset', () => {
      const s = set();
      s.setOffset(1, 500);
      expect(s.at(25 * MIN)!.localUs).toBe(MIN - 500_000);
      expect(s.at(MIN)!.localUs).toBe(MIN);
    });
    it('unplaces a file whose start is taken by another', () => {
      const s = set();
      s.setStart(1, 0);
      expect(s.placements().map((p) => p.startUs)).toEqual([null, 0]);
      expect(s.at(25 * MIN)!.file).toBe(1);
    });
    it('shows nothing before the first placed start', () => {
      const s = set();
      s.setStart(0, null);
      expect(s.at(MIN)).toBeNull();
      expect(s.nextBoundary(MIN)).toBe(24 * MIN);
    });
    it('remembers placements per playlist', () => {
      const s = set();
      s.setStart(1, 20 * MIN);
      expect(s.usePlaylist('00001', [0]).placed).toBe(false);
      s.usePlaylist('00000', [0, 24 * MIN]);
      expect(s.placements()[1]!.startUs).toBe(20 * MIN);
    });
  });
  ```
- [ ] **Step 2–4:** fail, implement, pass.
- [ ] **Step 5: Commit.** `git commit -m "feat(subs): episode subtitle sets"`

### Task 17: Protocol and player

**Files:** Modify `src/engine/protocol.ts`, `src/engine/player.ts`, `src/engine/worker.ts` (production `FontLoader` over `self.fonts`, default font fetch, canvas measurer), `src/engine/render/compositor.ts` (`storage` from the last frame's `codedWidth`/`codedHeight`), `src/player/player-controller.ts` (`reduceEvent` for the new fields). Test: `src/engine/player.test.ts`, `src/player/player-controller.test.ts`.

**Interfaces:**
- Consumes: `TextSet`, `sortByName`, `episodeStarts` (Task 16), `AssRenderer` (Task 14), `AssFonts`, `FontLoader` (Task 5), `looksLikeAss`, `parseAss` (Task 3).
- Produces:
```ts
// protocol.ts
export type NoticeCode = 'bdj' | 'audio-disabled' | 'decoder-recovered' | 'uo-masked' | 'subtitle-file' | 'subtitle-fonts';
export interface FileData { readonly name: string; readonly bytes: ArrayBuffer }
export interface TextFileInfo { readonly name: string; readonly format: 'srt' | 'ass'; readonly cues: number; readonly startUs: number | null; readonly offsetMs: number }
// EngineCommand (addTextSubtitle is replaced)
  | { readonly type: 'addTextSubtitles'; readonly files: readonly FileData[]; readonly encoding?: string; readonly fonts?: readonly FileData[] }
  | { readonly type: 'addSubtitleFonts'; readonly fonts: readonly FileData[] }
  | { readonly type: 'setSubtitleStart'; readonly file: number; readonly startUs: number | null }
  | { readonly type: 'setSubtitleOffset'; readonly file: number; readonly ms: number }
// EngineEvent
  | { readonly type: 'subtitleEncodingNeeded'; readonly names: readonly string[] }
  | { readonly type: 'subtitles'; readonly pg: readonly PgTrack[];
      readonly text: { readonly files: readonly TextFileInfo[]; readonly missingFonts: readonly string[]; readonly episodeStarts: readonly number[] } | null;
      readonly selected: 'off' | 'text' | { readonly pg: number }; readonly scale: number }   // top-level offsetMs removed
// Telemetry
  readonly ass: { readonly events: number; readonly animated: number; readonly renderMs: number; readonly overBudget: number } | null;
  readonly textFile: number | null;   // index of the set's file showing now
// PlayerDeps (player.ts)
  readonly createAssDeps?: () => Promise<{ readonly loader: FontLoader; readonly defaultFont: FontFile; readonly measurer: GlyphMeasurer; readonly createCanvas: (w: number, h: number) => OffscreenCanvas; readonly Path2D: typeof Path2D }>;
```
`Player.addTextSubtitles` is async. It decodes every file (BOM, strict UTF-8, then the command's `encoding`); if any file needs an encoding and none was given, it emits `subtitleEncodingNeeded { names }` and stops (the UI resends the whole load with one). Each file is parsed as ASS (`looksLikeAss`) or SRT; files without events are left out with the notice `<name>: this file has no subtitles we can read`; the partial-parse notice is per file. If no file is left, the old set stays. When any ASS file is present: one `AssFonts` for the set (`createAssDeps` once per worker), add the picked fonts and every ASS file's `[Fonts]`, resolve every family named by a style or an `\fn` of every ASS file, `await fonts.ready()`. A load generation number taken at the start is checked after every `await`: if the disc closed or another load started meanwhile, the fonts are disposed and nothing changes (Review Focus 5). Then the set is built (`sortByName`, a renderer per file: `TextSubtitleRenderer` or `AssRenderer` with `colorMatrix: 'video'`), `usePlaylist(currentPlaylistId, episodeStarts(timeline items))` runs (the placement notice when `placed` is false), the text choice is selected, and the fonts notices are sent.

Drawing: `TextSet.at(playlistUs)` picks the file and local time; the compositor draws that file's renderer at `localUs` with offset 0 (the set has applied it). `changed` is also true when `nextBoundary` is crossed. On every playlist start the set's `usePlaylist` runs for it. Seeks call `reset()` on every ASS renderer of the set. `[`/`]` (`setSubtitleOffset` from the UI) target the file showing. `addSubtitleFonts` adds, re-resolves, awaits, calls `fontsChanged()` on the ASS renderers, re-emits `subtitles`. Telemetry `ass` from the showing ASS renderer's `stats()`, else null; `textCue` uses its `visible`; `textFile` is `at(now)?.file ?? null`.

- [ ] **Step 1: Write the failing tests** in `player.test.ts` with fake ASS deps:
  - an ASS file with a picked font loads: `subtitles.text.files[0]` has `format: 'ass'`, `startUs: 0`; `missingFonts: []`;
  - a missing family produces `missingFonts: ['Fancy']` and one `subtitle-fonts` notice with the exact message; `addSubtitleFonts` with the right font clears it and emits `subtitles` again; an unreadable font gives the unreadable notice;
  - closing the disc while the fake loader's promise is pending installs nothing and emits nothing about that load afterwards; a second load while the first's fonts are pending keeps only the second;
  - two files on a playlist with two play items are placed at the two item starts; telemetry `textFile` is 0 in item 1 and 1 in item 2; three files on that playlist place only the first and send the placement notice;
  - `setSubtitleStart { file: 1, startUs: <chapter 3's start> }` moves it and `subtitles` reports it; `setSubtitleOffset { file: 1, ms: 200 }` changes only file 1;
  - a set where one file is not UTF-8 emits `subtitleEncodingNeeded { names: [that file] }`; resending with an encoding loads both;
  - an SRT alone still loads as in M4a (`format: 'srt'`, `startUs: 0`); telemetry `ass` is null with SRT.
  In `player-controller.test.ts`: `reduceEvent` copies the new `text` shape.
- [ ] **Step 2–4:** fail, implement, pass. Update existing M4a tests to the new command and event shapes. Run `npm run typecheck && npm test`.
- [ ] **Step 5: Commit.** `git commit -m "feat(subs): subtitle sets with ASS tracks and font loading in the player"`

### Task 18: UI

**Files:** Modify `src/player/player-controller.ts` (`loadSubtitleFiles(files: readonly File[], encoding?: string)` replaces `loadSubtitleFile`, `addSubtitleFonts(files: readonly File[])`, `setSubtitleStart(file: number, startUs: number | null)`, `shiftSubtitles` sends the showing file's index from telemetry `textFile`, the encoding prompt keeps the whole pending load), `src/ui/SubtitleMenu.tsx` (`accept=".srt,.ass,.ssa,.ttf,.otf,.ttc,.woff,text/plain"`, `multiple`; "Load subtitle files…"; the per-file list of spec §5; "Add fonts…" and the missing-fonts line when any file is ASS), `src/ui/EncodingPrompt.tsx` (lists the names), `src/ui/PlayerScreen.tsx` (drop handler uses `drop-files.ts`). Create `src/ui/drop-files.ts`, `src/ui/subtitle-starts.ts`. Test: `src/player/player-controller.test.ts`, `src/ui/drop-files.test.ts`, `src/ui/subtitle-starts.test.ts`.

**Interfaces (produces):**
```ts
// drop-files.ts
export const SUBTITLE_EXTENSIONS: readonly string[]; // .srt .ass .ssa
export const FONT_EXTENSIONS: readonly string[];     // .ttf .otf .ttc .woff
export function splitPick(files: readonly File[]): { readonly subtitles: readonly File[]; readonly fonts: readonly File[] };
/** Files of a drop: plain files, and for dropped folders their files one level of subfolders deep (webkitGetAsEntry). */
export function collectDroppedFiles(items: DataTransferItemList): Promise<File[]>;
// subtitle-starts.ts: the start picker's choices and the label of a placement
export interface StartChoice { readonly label: string; readonly startUs: number | null }
/** "Episode n · 0:23:41" for each episode start, "Chapter n · 0:23:41" for each chapter, "Current position · <time>", "Not placed". */
export function startChoices(episodeStarts: readonly number[], chapters: readonly Chapter[], nowUs: number): StartChoice[];
/** "0:23:41 · Chapter 6", "0:23:41 · Episode 2" (an episode start that is also a chapter says Episode), "0:12:05", or "Not placed". */
export function startLabel(startUs: number | null, episodeStarts: readonly number[], chapters: readonly Chapter[]): string;
```
`loadSubtitleFiles` applies the size caps of Global Constraints (notice for skipped fonts) and a cap of 64 subtitle files (the rest are skipped with the notice `Only the first 64 subtitle files were loaded`), then posts `addTextSubtitles` with the files and fonts (all buffers transferred). A pick of only fonts with an ASS file in the set calls `addSubtitleFonts`.

- [ ] **Step 1: Write the failing tests:** `splitPick` with `[b.ass, a.srt, x.ttf, y.OTF, readme.txt]` returns subtitles `[b.ass, a.srt]` and fonts `[x.ttf, y.OTF]`; `loadSubtitleFiles` posts one `addTextSubtitles` with two files and two fonts and transfers four buffers; a 70 MiB font is skipped with the exact notice; 65 subtitle files load 64 with the notice; fonts only, with an ASS file in the set → `addSubtitleFonts`; the encoding prompt answer resends the whole load; `shiftSubtitles` targets telemetry's `textFile` and does nothing when it is null; `startChoices` lists episodes, then chapters, then current position, then Not placed with the exact labels; `startLabel` prefers "Episode" when a start is both; `collectDroppedFiles` with a fake folder entry of two files and a nested folder of one file returns three files, and ignores a second level.
- [ ] **Step 2–4:** fail, implement, pass.
- [ ] **Step 5: Commit.** `git commit -m "feat(ui): subtitle sets with episode placement, ASS fonts by menu or drop"`

### Task 19: End-to-end

**Files:** Modify `tests/e2e/subtitles.spec.ts` (M4a's SRT tests move to the new menu label and command). Create `tests/e2e/fixtures/sign.ass` (a dialogue line and an animated sign with `\move`, `\t` and `\clip`, fonts DejaVu Sans and DejaVu Serif, times inside the synthetic disc's duration), `tests/e2e/fixtures/missing-font.ass` (style font `Fancy`), `tests/e2e/fixtures/ep1.ass` and `ep2.ass` (one event each, from 0.5 s to 1.5 s local time, different text).

- [ ] **Step 1: Write the failing tests:**
  - `sign.ass` with `DejaVuSans.ttf` and `DejaVuSerif.ttf` through the menu's file input (multi-file) shows events at their time (telemetry `ass.events ≥ 1`, `textCue`), animated count 1 while the sign is up; the same by dropping the three files;
  - `missing-font.ass` alone shows the notice `Some fonts are missing and were replaced: Fancy` and the menu line; "Add fonts…" with a font whose family is `Fancy` (generated in the test by renaming DejaVu Sans's name records, helper `tests/helpers/font-rename.ts`) clears both;
  - `]` moves the showing file's event by 100 ms;
  - on `fixtures/synthetic/disc1` playlist 00000 (two play items, first check its item durations in `scripts/make-fixture-disc.ts`), loading `ep2.ass` and `ep1.ass` together places `ep1` at item 1's start and `ep2` at item 2's (menu labels), telemetry `textFile` is 0 then 1 as playback crosses into item 2, with `textCue` at 0.5–1.5 s after each start; choosing a chapter for `ep2` in the start picker moves where it shows;
  - the A/V sync assertions of `playback.spec.ts`'s steady-state test hold with `sign.ass` on (reuse its helper), and `ass.overBudget` is 0.
- [ ] **Step 2–4:** fail, fix, pass: `npm run test:e2e -- subtitles`.
- [ ] **Step 5: Commit.** `git commit -m "test(e2e): ASS subtitles, fonts and episode sets"`

---

## Phase G: real corpus, performance, docs

### Task 20: Local corpus gate and performance

**Files:** Create `tests/ass-trace/times.ts`, `tests/ass-trace/local.spec.ts`. Test: `tests/ass-trace/times.test.ts`.

**Interfaces (produces):**
```ts
// times.ts
/** times.txt when present; else every event's start, midpoint and last frame (end − 1 ms at 1 ms granularity is libass's last shown time: end − 1), plus every frame (41 ms) of the ten animated events with the most override tags. Sorted, unique. */
export function sampleTimes(track: AssTrack, explicit: readonly number[] | null): number[];
export function localFixtures(): AssFixture[];  // fixtures/local/ass/<name>/: the .ass, every font file in the folder, times
```
`local.spec.ts` runs only with `ASS_LOCAL=1` (skips otherwise, and when the folder is absent): for each local fixture it runs the harness live (`tools/ass-trace/run.sh` into `tools/ass-trace/out/local/<name>/`, cached by the file's hash), compares layout and pixels as Tasks 11 and 15 do, and records `renderMs` per frame from the page's `AssRenderer.stats()` to assert the performance budget (95th percentile of animated frames < 8 ms, static frames < 1 ms).

- [ ] **Step 1: Write the failing test** `times.test.ts`: an event 1000–3000 gives 1000, 2000, 2999; an animated event adds a frame every 41 ms; `times.txt` replaces sampling.
- [ ] **Step 2–4:** fail, implement, pass.
- [ ] **Step 5: Ask the user for the corpus.** Stop and ask the user to put their files in `fixtures/local/ass/<name>/` (the `.ass` plus its fonts). Do not continue the gate without them.
- [ ] **Step 6: Run the gate.** `ASS_LOCAL=1 npm run test:ass -- local`. Fix porting bugs until it passes; anything that remains is a raster difference to record (Task 21) and report to the user with its diff images, per spec §6.4.
- [ ] **Step 7: Commit.** `git commit -m "test(ass): local corpus gate with performance budget"`

### Task 21: Docs

**Files:** Modify `docs/known-issues.md`, `src/engine/NOTICE`, `CLAUDE.md`, `docs/superpowers/specs/2026-10-12-bluray-web-player-design.md` (§11 milestone 4 line), `docs/superpowers/specs/2026-10-15-m4b-ass-renderer-design.md` (Status line and a §10 Deviations section listing the seven planning deviations above and any decided while implementing).

- [ ] **Step 1:** `known-issues.md`: replace "ASS/SSA files are not supported yet" with what is deferred (MKV extraction, `queryLocalFonts()`, WOFF2, legacy `Effect` effects, mixed-direction text across style runs, line breaking without libunibreak) and any corpus exceptions from Task 20 with their causes. `NOTICE`: libass's ISC notice and every ported file with its libass sources; DejaVu's licence for `default-font.ttf`. `CLAUDE.md`: M4b done; the `ass-trace` commands next to `vm-trace`; `npm run test:ass`; `ASS_LOCAL=1`; the `ass/` module in Architecture.
- [ ] **Step 2: Verify.** `npm run typecheck && npm test && npm run test:e2e && npm run test:ass`, and `npm run ass-trace:golden && git diff --exit-code tests/ass-trace/golden/`.
- [ ] **Step 3: Commit.** `git commit -m "docs: M4b native ASS renderer"`
