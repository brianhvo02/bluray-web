# Milestone 4b: Native ASS Renderer — Design Spec

Date: 2026-10-15
Status: Done (2026-10-15). Plan: `docs/superpowers/plans/2026-10-15-m4b-ass-renderer.md`; deviations in §10.
Parent spec: `2026-10-12-bluray-web-player-design.md` (§6 ASS, §9 golden images, §11 milestone 4). Builds on `2026-10-15-m4a-pgs-srt-design.md` (text track, subtitle menu, offset and size controls) and the M3 trace harness pattern (`tools/vm-trace/`).

## 1. Goal and scope

A user watching a disc can load an `.ass` or `.ssa` file together with its fonts and see it rendered close to libass, including full fansub typesetting: signs with `\clip`, `\t`, `\move`, `\org`, 3D rotation, `\p` drawings and karaoke. Fidelity is measured against libass itself: a layout trace and golden images from a pinned libass, on committed synthetic files and on the developer's own real-world files.

In scope:

- Parsing `[Script Info]`, `[V4+ Styles]` / `[V4 Styles]`, `[Events]` (Dialogue) and `[Fonts]`.
- Every override tag libass supports, with libass's timing, interpolation and compatibility quirks.
- Fonts supplied with the subtitle file (`.ttf .otf .ttc .woff .woff2`) and fonts embedded in `[Fonts]`; libass's font matching rules; a fallback with a notice naming missing families.
- Layout as libass does it: PlayRes/LayoutRes scaling, WrapStyle 0–3, alignment, margins, `\pos` `\move` `\org`, the 3D transform, border and shadow geometry, collision stacking.
- Drawing with Canvas2D in the engine worker, including `\frx`/`\fry` (not flat).
- A libass trace harness (`tools/ass-trace/`) producing layout traces and golden PNGs, compared in CI and on local files.
- Integration into M4a's text track: protocol, `Player`, subtitle menu, drag and drop, telemetry.
- Episode subtitle sets (SRT and ASS): several files loaded at once, each placed at an episode's start in a multi-episode playlist, switching automatically (§3.5).

Out of scope: loading `.mkv` files to extract subtitles and attachments, and installed system fonts via `queryLocalFonts()` (both a later milestone); rendering SRT through the ASS engine; a style override option; `Comment`, `Picture`, `Sound`, `Movie` and `Command` events; the legacy `Effect` field effects (`Banner`, `Scroll up`, `Scroll down`), which move into scope if a corpus file uses them; JASSUB (see §6.4).

Decisions taken during brainstorming:

| Question | Decision |
|---|---|
| Fidelity target | Full fansub typesetting, close to libass |
| Approach | Port libass's logic function by function (parsing, tags, layout); draw with Canvas2D. Not an original renderer, not JASSUB |
| Rasterization | The browser's (`fillText`/`strokeText`, `Path2D`, `ctx.filter`); libass's rasterizer, stroker and blur are not ported |
| `\frx`/`\fry` | Rendered, through a mesh warp of per-glyph bitmaps |
| Fonts | The subtitle file plus font files picked or dropped with it, and `[Fonts]`. MKV extraction and `queryLocalFonts()` are a later milestone |
| Corpus | The developer's real files in gitignored `fixtures/local/ass/`; committed synthetic files for CI |
| Verification | Layout trace plus golden PNGs from a pinned libass in Docker, like vm-trace |
| Multi-episode titles | A set of subtitle files, each placed at an episode start (auto-placed on play items, or chosen from chapters), switching automatically (added after the spec was first approved) |

## 2. Components

Ported code comes from libass at release 0.17.5 (commit `4a05d8127f525943ebf45fdc6497c9e665947f0d`); `scripts/fetch-libass.sh` puts the source in `.cache/libass`. libass is ISC-licensed, which is compatible with the engine's LGPL-2.1. Each ported file carries an SPDX header naming both and is listed in `src/engine/NOTICE` with its libass source files. Original files are LGPL-2.1-or-later like the rest of the engine.

| File | Source | Responsibility |
|---|---|---|
| `ass/parse.ts` | `ass.c`, `ass_utils.c` | `parseAss(text)` returns a `Track`: script info (PlayResX/Y with libass's defaults when missing, LayoutResX/Y, WrapStyle, ScaledBorderAndShadow, YCbCr Matrix, Kerning), styles (v4+ and v4 formats, the `Format:` line honoured), Dialogue events (Layer, Start, End, Style, Name, margins, Effect, Text, and ReadOrder by file order), and `[Fonts]` entries uudecoded into bytes. Text decoding reuses M4a's `decodeText`. Malformed lines are skipped and counted. |
| `ass/tags.ts` | `ass_parse.c` | Parses override blocks and applies them to the render state at time t: `\b \i \u \s \fn \fs \fscx \fscy \fsp \fe \c \1c–\4c \alpha \1a–\4a \bord \xbord \ybord \shad \xshad \yshad \be \blur \pos \move \org \frx \fry \frz \fr \fax \fay \fad \fade \clip \iclip` (rectangle and vector) `\k \K \kf \ko \kt \q \r \p \pbo \an \a`, and `\t(t1,t2,accel,…)`. It follows libass on repeated tags (first or last wins per tag), malformed arguments, `\pos`/`\move` exclusivity and the VSFilter compatibility rules. |
| `ass/fonts.ts` | `ass_fontselect.c` (matching rules only) | Reads family, full and PostScript names, weight and italic flags from the name and OS/2 tables (TTF, OTF, TTC collections, WOFF/WOFF2 after the browser decodes them); matches a requested family, bold and italic the way libass does; registers matched faces as `FontFace`s in the worker under private names; records missing families. Fallback is the browser's `sans-serif`. |
| `ass/drawing.ts` | `ass_drawing.c` | `\p` drawing commands and vector `\clip`/`\iclip` into `Path2D`: `m n l b s p c`, the b-spline segments, `\p` scale and `\pbo`. |
| `ass/layout.ts` | `ass_render.c` (layout half), `ass_bitmap.c` (geometry only) | Splits an event into glyph runs by render state; measures with the registered fonts; wraps (WrapStyle 0 smart, 1 end-of-line, 2 none, 3 smart with lower lines wider, plus `\N`, `\n`, `\h`); aligns; applies margins and `\pos`/`\move`/`\org`; computes the 3D transform (`\frx \fry \frz \fax \fay \fscx \fscy`, the libass perspective); computes border and shadow offsets with ScaledBorderAndShadow; runs collision stacking with libass's per-layer position memory across frames. Output is a `LayoutEvent`: positioned glyph runs, their transforms, clip, layer, and whether it changes with time. |
| `ass/raster.ts` | original | Draws a `LayoutEvent` with Canvas2D (§3.3). |
| `ass/renderer.ts` | `ass_render.c` (frame loop, caching) | `AssRenderer` implements `TextRendererLike` (`render`, `changed`): selects the events active at t (libass's start-inclusive, end-exclusive rule), orders them by Layer then ReadOrder, lays them out, draws them, and caches (§3.4). |
| `player.ts` | — | The text track becomes `{ format: 'srt' \| 'ass', … }`, with a `TextRendererLike` renderer either way. |
| `protocol.ts` | — | See §4. |
| UI | — | `SubtitleMenu` and `PlayerScreen` (§5). |

## 3. Runtime behaviour

### 3.1 Loading

- The engine detects the format by content (a `[Script Info]` or `[V4+ Styles]`/`[V4 Styles]` section header within the first 4 KiB), not by extension, and parses either SRT or ASS.
- Fonts from the command and from `[Fonts]` are parsed for names. Unreadable files are skipped with a notice naming them. Faces are registered lazily when an event first needs them, so a file with fifty fonts that uses five loads five.
- After parsing, every family referenced by a style or a `\fn` is matched. Families with no match go into `missingFonts`, with one `subtitle-fonts` notice per load listing them.
- `addSubtitleFonts` adds faces to the current track, clears the layout cache, and recomputes `missingFonts`.
- The track, its fonts and their `FontFace`s are dropped when the track is removed or replaced, or the disc closes.

### 3.2 Coordinates and scaling

- Layout runs in script coordinates. They are scaled to the fitted video rectangle as libass scales to its frame size: PlayResX/Y to the rectangle, with the storage aspect from LayoutResX/Y when present and the video's coded size otherwise, so anamorphic scripts behave as in libass.
- Drawing happens at the display size of the video rectangle, so text stays sharp at any window size. Goldens are compared at 1920×1080.
- The user's size scale maps to libass's `ass_set_font_scale`: it scales font sizes, borders and shadows, and leaves `\pos`, `\move`, `\org`, clips and drawings in place.
- The user's offset shifts event times, as for SRT; in a set, each file has its own (§3.5).

### 3.3 Drawing

Per event, in libass's order (shadow, then border, then fill, per glyph run, then the clip):

- **Fill and border.** Glyph runs are drawn with `fillText` in the registered font; borders with `strokeText` at twice the border width with round joins, the fill drawn over it. `\xbord`/`\ybord` that differ are drawn by stroking in a scaled coordinate system. With an opaque border box (BorderStyle 3), the box is drawn as a rectangle as libass does.
- **Shadow.** The border shape (or the fill when there is no border) is drawn again at the `\shad`/`\xshad`/`\yshad` offset in the back colour.
- **Blur.** `\blur` uses `ctx.filter = blur(σ)` with σ mapped from libass's Gaussian kernel; `\be` uses repeated box-blur passes as in libass. Blur applies to the border when there is one, otherwise to the fill, matching libass.
- **Transforms.** 2D transforms (`\frz`, `\fax`, `\fay`, `\fscx`, `\fscy`, `\org`) are `setTransform` per glyph run. When `\frx` or `\fry` is non-zero, each glyph is drawn into a small bitmap, then projected with libass's 3D matrix by subdividing the bitmap into a grid of triangles, each drawn with its own affine transform and clipped to the triangle. The grid is fine enough to keep the error below the pixel threshold, and coarser for small glyphs.
- **Clips.** Rectangle and vector `\clip` become canvas clip paths; `\iclip` uses the even-odd rule over the frame rectangle plus the clip path.
- **Drawings.** `\p` paths are filled, stroked and shadowed like glyphs.
- **Karaoke.** `\k`/`\K`/`\kf`/`\ko` switch or sweep between primary and secondary colours per syllable; `\kf` sweeps by clipping each glyph run at the progress point, as libass does.
- **Colour.** libass does not convert colours for the script's `YCbCr Matrix`; players do. In the player, `AssRenderer` converts BT.601 scripts (`TV.601`, `PC.601`, and `Default`/missing as VSFilter assumes) to the BT.709 video, as mpv does, and leaves `None` and BT.709 scripts untouched. Golden comparisons render without conversion.

### 3.4 Caching and redraws

- An event is **static** when nothing in it depends on time inside its interval (no `\t`, `\move`, `\fad`/`\fade`, karaoke). It is drawn once into an `ImageBitmap` at the current rectangle size and reused until the rectangle, the scale or the fonts change.
- An **animated** event is drawn every frame. Its layout is cached when only colours, alphas or clip change over time; a `\t` on size, spacing, scale or rotation reruns layout.
- `changed(timeUs)` is true when the set of active events changes or any active event is animated, so the compositor redraws only then.
- Collision memory follows libass: positions of events already shown are kept so a later event does not push an earlier one, and it is cleared on seek.

### 3.5 Episode subtitle sets

Applies to SRT and ASS alike; it replaces M4a's single text track with a set of 1–64 files (a single file at the playlist start behaves exactly as before).

- **Files.** Each file has a start (a playlist time, or not placed) and its own offset. A placed file is shown only from its start until the next placed file's start (the last until the playlist ends). Inside that window its event times are `playlist time − start − offset`. Files may mix SRT and ASS; the ASS files of a set share one font collection, so fonts picked once serve every file, and missing families are reported once for the set.
- **Order.** Files are sorted by name with numeric collation (`Intl.Collator(undefined, { numeric: true })`), so `ep2` precedes `ep10`.
- **Automatic placement.** Episode starts are the playlist times of play items lasting at least 5 minutes; if no play item does, every play item counts (short discs). When the number of files equals the number of episode starts, file *n* is placed at episode start *n*. Otherwise the first file is placed at the playlist start, the others are not placed, and the notice `Place each subtitle file at its episode's start in the subtitle menu` appears.
- **Per playlist.** Starts are remembered per playlist ID. When another playlist plays, its remembered starts apply, or automatic placement runs for it.
- **Manual placement.** A file can be placed at any episode start, any chapter, the current position, or not placed. Two files may not share a start: placing a file where another one is unplaces the other.
- **Offset keys.** `[` and `]` shift the file whose window contains the current time (no change, and no notice, when none does).
- **Loading.** A pick or drop of subtitle files replaces the whole set. The encoding prompt appears once per load, and its choice applies to every file of the load that is not UTF-8. A file with no readable events is left out with the notice `<name>: this file has no subtitles we can read`; when none is readable, the existing set stays.

## 4. Protocol

Commands:

- `addTextSubtitles { files: readonly { name: string; bytes: ArrayBuffer }[]; encoding?; fonts?: readonly { name: string; bytes: ArrayBuffer }[] }` replaces M4a's `addTextSubtitle`: the set and its fonts, transferred together.
- `setSubtitleStart { file: number; startUs: number | null }`: places a file of the set (index in name order) or unplaces it.
- `setSubtitleOffset { file: number; ms: number }`: gains the file index.
- `addSubtitleFonts { fonts: readonly { name: string; bytes: ArrayBuffer }[] }`: adds fonts to the loaded ASS track; ignored with no ASS track.

Events:

- `subtitles.text` becomes `{ files: readonly { name; format: 'srt' | 'ass'; cues; startUs: number | null; offsetMs }[]; missingFonts: readonly string[]; episodeStarts: readonly number[] } | null` (`cues` counts events for ASS), and the event's top-level `offsetMs` goes (it is per file now). Chapters reach the UI through the existing `chapters` event.
- `subtitleEncodingNeeded` gains `names: readonly string[]` (the files of the load that need it).
- `NoticeCode` gains `subtitle-fonts`: missing families or unreadable font files.

Telemetry gains `ass: { events: number; animated: number; renderMs: number; overBudget: number } | null`. `renderMs` is the time of the last subtitle draw. `overBudget` counts frames over 8 ms.

## 5. UI

- "Load subtitle files…" accepts `.srt .ass .ssa .ttf .otf .ttc .woff .woff2` with multiple selection. Every subtitle file of the pick joins the set (§3.5), and font files go with them.
- Dropping files works the same way. A dropped folder is walked (one level of subfolders) for subtitle files and fonts.
- The menu lists the set's files, each with its start ("0:23:41 · Chapter 6", "Episode 2", or "Not placed"), a start picker (episode starts, chapters, "Current position", "Not placed") and offset − / + with its value. The file showing now is marked.
- With an ASS track loaded, the subtitle menu shows "Add fonts…" and, when families are missing, a warning line naming them.
- The offset and size controls apply to ASS as described in §3.2; size is one setting for the set.

## 6. Verification

### 6.1 The libass trace harness

`tools/ass-trace/` builds a Docker image with libass 0.17.5, FreeType, HarfBuzz and FriBidi at pinned versions, plus a C harness `ass_trace.c` and `trace.patch` on libass. Given a `.ass` file, a fonts directory, a frame size and a list of times, it writes:

1. **A layout trace** (JSON lines, one per event per time): the event's index, layer and ReadOrder; per glyph run the resolved style (font family and the file it matched, size, scale, spacing, colours, alphas, border, shadow, blur, karaoke state); per glyph its position and advance; line breaks; the event's final position after collision handling; the transform matrix; the clip. The patch adds the hooks in `ass_render.c`.
2. **Golden PNGs**: libass's `ASS_Image` list blended onto a transparent RGBA frame at each time.

The harness sets the frame size, storage size, font scale 1, the video matrix to BT.709, and no system fonts (fontconfig pointed at an empty directory, DejaVu Sans as the fallback) so results depend only on the supplied fonts. The engine falls back to the browser's `sans-serif`, which cannot match, so events drawn in a missing family are compared only on the reported family (`missingFonts`), not on positions or pixels.

Commands: `npm run ass-trace:build`, `npm run ass-trace:golden` (regenerates committed goldens; never edit them by hand), `npm run ass-trace -- <file.ass> <fonts dir> <times file>`.

### 6.2 Comparison

- **Layout** (`tests/ass-trace/`, Playwright in Chrome, because measurement and shaping must be the browser's; unit tests elsewhere use a fake measurer): the engine's `LayoutEvent`s are serialized in the trace format and compared field by field. Discrete fields (line breaks, matched font, collision order, clip type, karaoke state) must match exactly; positions within 0.5 px at 1920×1080, to allow for sub-pixel advance differences between FreeType and Chrome. A divergence is a porting bug fixed in the port, never in a golden file.
- **Pixels** (Playwright in Chrome): the same frames are rendered through `AssRenderer` into an `OffscreenCanvas` and compared with the goldens using `pixelmatch` (anti-aliasing tolerance on), with a per-frame budget of differing pixels (0.5% of the subtitle's bounding box, and a fixed floor for small events). Failures save the actual, expected and diff images.

### 6.3 Corpus

- **Synthetic, committed** (`fixtures/ass/`): files written by hand, one per tag family and for the hard combinations: `\t` with acceleration over several tags, nested and sweeping karaoke, collisions across layers, every WrapStyle with long lines, `\org` with `\frz`, `\frx`/`\fry`, rectangle and vector `\clip`/`\iclip`, `\p` with `\pbo` and b-splines, BorderStyle 3, `\be` against `\blur`, anamorphic LayoutRes, v4 styles, `[Fonts]`. They use open-licence fonts committed alongside (Noto and DejaVu subsets). Their traces and goldens are committed; `.github/workflows/ass-trace.yml` regenerates them and fails on any diff.
- **Local, real-world** (`fixtures/local/ass/<name>/`: `<name>.ass`, its fonts, an optional `times.txt`; gitignored): when `times.txt` is absent, times are generated from every event's start, midpoint and last frame, plus every frame of the ten busiest animated events. `ASS_LOCAL=1` generates goldens live in Docker and runs both comparisons. Tests skip when the folder is absent.

### 6.4 The JASSUB rule

If, after porting, a real file still fails the pixel comparison for a reason that cannot be fixed in the port (a rasterization difference rather than a layout one), the failure and its diff images are recorded in `docs/known-issues.md`. Adding JASSUB behind `TextRendererLike`, chosen per file by a feature scan, is then a separate decision and not part of M4b.

### 6.5 Other tests

- Unit tests: parsing edge cases (missing sections, reordered `Format:`, v4 styles, comments, BOM), uudecode, font name tables and matching, each tag's parsing and interpolation, drawing commands, wrapping per WrapStyle, collision stacking, the cache's static/animated split, format detection.
- E2E (`tests/e2e/subtitles.spec.ts`): an ASS file with fonts loaded through the menu and by drag and drop shows its event at the right time (telemetry `ass.events`); a missing font produces the notice and the menu warning; "Add fonts…" clears it; the offset shifts events; a two-file set on a two-item playlist is placed automatically, shows file 1's event in item 1 and file 2's in item 2, and re-placing file 2 on a chapter moves it; the A/V sync test still passes with an animated ASS track on.

## 7. Performance

Measured with telemetry `ass.renderMs` in Chrome at a 1920×1080 video rectangle:

- A frame with only static events draws from the cache in under 1 ms.
- On the busiest animated sign in the local corpus, the 95th percentile frame stays under 8 ms.
- If a file goes over budget, the next step is profiling and finer caching (bitmaps per glyph run keyed by their render state, as libass caches). Effects are never dropped to meet the budget.

## 8. Phases

Delivered phase by phase on main:

1. **Harness:** `scripts/fetch-libass.sh`, `tools/ass-trace/` (Dockerfile, patch, harness, scripts), trace format, comparer skeleton, first synthetic file and golden.
2. **Parsing and fonts:** `parse.ts`, `[Fonts]`, `fonts.ts` (name tables, matching, `FontFace` registration).
3. **Tags and timing:** `tags.ts`, including `\t`, karaoke, `\move`, `\fad`/`\fade`, `\r`.
4. **Layout:** `drawing.ts` and `layout.ts`, compared against layout traces.
5. **Raster:** `raster.ts` and `renderer.ts`, compared against golden PNGs.
6. **Integration:** episode subtitle sets, protocol, `Player`, menu, drag and drop, fonts, telemetry, E2E.
7. **Real-corpus gate and performance tuning.**

## 9. Exit criteria

1. CI is green, including the ASS trace workflow.
2. Every synthetic fixture matches its layout trace and passes the pixel comparison.
3. With `ASS_LOCAL=1`, every file in `fixtures/local/ass/` passes layout and pixels; any exception is in `docs/known-issues.md` with its diff image and cause.
4. The performance budget (§7) holds on the local corpus during disc playback, and the A/V sync E2E passes with an ASS track on.
5. `docs/known-issues.md` lists what is deferred: MKV extraction, `queryLocalFonts()`, legacy `Effect` effects, and JASSUB (only if criterion 3 calls for it).

## 10. Deviations

Decided while planning (the plan's list):

1. The harness libass is built without libunibreak; lines break as libass does without it (spaces, ZWSP).
2. No FriBidi reordering across style runs; Chrome reorders right-to-left text within a run.
3. WOFF2 is not accepted (`.ttf .otf .ttc .woff` are).
4. Goldens are opaque: libass's images are blended onto `#808080`, and the page fills the same colour first.
5. Fonts are matched when the track loads, not lazily (`FontFace.load()` is asynchronous; libass's rendering is not).
6. Synthetic bold and italic are libass's strengths and shear applied when drawing, not Chrome's synthesis.
7. The colour-matrix conversion is the player's (§3.3 said libass converts; it does not): `Default`/missing and
   `*.601` scripts are converted BT.601 → BT.709, the trace page converts nothing.

Decided while implementing:

8. **Rasterization is partly ours, not only the browser's** (§2 said `fillText`/`strokeText`, `Path2D` and
   `ctx.filter`). Glyphs are still drawn by the browser, but fill and border masks are supersampled and box-filtered
   in JS (4× static, 2× animated, raised until text is at least 256 device px, at most 8×: Chrome's glyph cache snaps
   the baseline to whole pixels below that); borders are strokes when round and uniform, otherwise a weighted
   distance-transform dilation; the mask blur is a Gaussian in JS with separate x/y deviations, because Chrome's
   CPU-backed canvas `blur()` drops deviations under 0.8 px. Runs whose shape changes every frame are drawn directly on
   GPU canvases (no read-back) when their compositing needs no `ass_fix_outline`.
9. **Shaping and font metrics follow FreeType where the browser differs:** GSUB `liga`/`clig`/`rlig` clusters are
   read from the font (`gsub.ts`), as HarfBuzz merges them; advances are whole pixels at the 256 px shaping size, at
   the rounded ppem for TrueType fonts whose head flags force it (hinted loads only; outlines and ascender/descender
   keep the requested size).
10. **libass's `quantize_transform` positions are ported:** a run moves by the 1/8 px rounding of its first inked
    glyph's box centre. Its matrix quantization is not (the matrix is used exactly).
11. **Not drawn as libass does:** BorderStyle 4's background box, vertical `@font` glyph rotation, `\be` as separate
    box passes (folded into the Gaussian), rotated anisotropic borders (dilated axis-aligned). Recorded in
    `docs/known-issues.md`.
12. **Trace format and tolerances:** `font` is `<requested family>|<PostScript name>`; numbers keep 6 decimals; the
    comparer allows 1e-5 on scale/rotation/shear, the position tolerance on translations and `\k` timings, 1 px on
    integer boxes and 2e-3 relative on perspective matrices. Frames where a run uses a missing family skip the pixel
    comparison and that event's box.
13. **One recorded corpus exception (§6.4):** fonts without TrueType hinting instructions get FreeType auto-hinter
    advances in libass's shaper (about 1 px per glyph at 256 px). The local gate reads per-fixture
    `exceptions.json` files and reports, but does not fail on, those events. JASSUB was not needed.
14. **WrapStyle 3 behaves like 0**, as in libass (its FIXME), not "lower lines wider" (§2).
15. **Episode sets** (§3.5) draw through one `TextSetRenderer` over the files; the player's global text offset became
    per file; an explicit seek clears ASS collision memory.

