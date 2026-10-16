# Video Shaders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run unmodified mpv user shaders (Anime4K in particular) over the video, from a library kept in the browser, chosen in a Shaders menu.

**Architecture:** A pure parser, RPN evaluator, frame planner and GLSL generator in `src/engine/shaders/` turn mpv `.glsl` files into a per-frame pass plan. A WebGL2 backend runs that plan on its own `OffscreenCanvas` in the engine worker, and `ShaderStage` (a state machine: off, compiling, active, error, unavailable) hands its output to `Compositor.drawVideo` in place of the raw frame, before PG, text and IG. On the main thread, an IndexedDB library, set resolution (built-in Anime4K modes and `input.conf` imports) and a `ShaderModel` drive a `ShaderMenu`.

**Tech Stack:** TypeScript (strict), WebGL2 with GLSL ES 3.00 and `EXT_color_buffer_float`, IndexedDB (`fake-indexeddb` in tests), React 19, Vitest, Playwright (Chrome).

**Spec:** `docs/superpowers/specs/2026-10-15-video-shaders-design.md`

## Global Constraints

- Work in the worktree `.claude/worktrees/video-shaders`, branch `spec/video-shaders`. Never commit to `main` and never touch the uncommitted `.github/workflows/ci.yml` change in the main checkout (another session's).
- `src/engine/` must not import React or anything from `src/ui/` or `src/player/`. `src/ui/` may import pure modules from `src/engine/shaders/` (`parse.ts`), as it already imports `protocol.ts` types.
- New engine files carry the SPDX/LGPL header used by `src/engine/render/compositor.ts`'s neighbours (copy the header of `src/engine/bdmv/mpls-parser.ts`, with "original code" wording, since nothing here is ported line by line).
- TypeScript strict, `noUnusedLocals`/`noUnusedParameters`, `verbatimModuleSyntax` (`import type` for types).
- New browser APIs (WebGL2, `OffscreenCanvas` for the backend, IndexedDB) stay behind injectable interfaces; unit tests use fakes.
- Anime4K is pinned to commit `7684e9586f8dcc738af08a1cdceb024cc184f426` (2024-04-25) of `https://github.com/bloc97/Anime4K`. (Deviation from spec §4.2's `v4.0.1`: that tag has no `md/Template/` folder and lacks several files; the file names are otherwise unchanged. Task 1 amends the spec.)
- Limits from the spec: shader file ≤ 4 MiB; up to 16 `BIND`s per pass; float formats R16F/RG16F/RGBA16F (3 components → RGBA16F); sampling LINEAR + CLAMP_TO_EDGE; drop-rate warning above 5 % over a 5 s window; `v`/`V` cycles sets.
- Picking files uses hidden `<input type="file">` elements (a `webkitdirectory` one for folders, like the disc `folder-input`), not `showDirectoryPicker`: Playwright can drive them and spec §10 leaves the picker to the builder.
- Copy (exact strings): menu button label `Shaders`; item `Off`; `Add shaders…`; `Manage…`; `Compiling…`; missing files `missing: <first name>` plus ` +N more` when N > 0; warning `<set>: <P> % frames dropped — try a Fast mode.` (P rounded to an integer); unavailable `Shaders need WebGL2 with float render targets, which this browser doesn't provide.`

## Review Focus

1. **`.glsl` files saved on Windows or by editors:** CRLF line endings, a UTF-8 BOM, trailing spaces after directives, `//!HOOK  MAIN` with two spaces. They must parse like the clean file. (Task 2.)
2. **Commands before a canvas or disc exists, and across discs:** `setVideoShaders` sent at app start (before `attachCanvas`), a compile finishing after `close` or after a new disc opens, a set chosen on the landing screen. The set must apply to whatever plays next and nothing may throw. (Task 6.)
3. **Window resize and fullscreen during playback:** `OUTPUT` changes, so `WHEN` results flip (the upscaler turns on or off) and textures change size. The next frame must use the new plan, with no stale-size output stretched into the new rect. (Tasks 4 and 6.)
4. **Paused video:** choosing, switching or turning off a set while paused must repaint the current frame shaded (or unshaded) at once, and a compile that finishes while paused must too. (Task 6.)
5. **Re-adding a file with the same name but new contents while its set is active:** the engine must recompile (cache keyed by content hash), not keep running the old program. (Tasks 6 and 9.)

---

## Task 1: Spike — CI's WebGL2 and `VideoFrame` upload size

Throwaway probe; its findings set two details of later tasks.

**Files:**
- Create (untracked, not committed): `spike/webgl-probe.spec.ts`, `spike/playwright.probe.config.ts`
- Modify: `docs/superpowers/specs/2026-10-15-video-shaders-design.md` (Anime4K pin; findings)
- Modify: this plan (record findings under "Spike findings" at the end)

- [ ] **Step 1: Write the probe.** A Playwright test against `npm run preview` that, in a dedicated worker created from a Blob URL, creates `new OffscreenCanvas(64, 64).getContext('webgl2')` and reports: context present; `getExtension('EXT_color_buffer_float')` present; `RENDERER`/`VERSION` strings; `MAX_TEXTURE_IMAGE_UNITS`; whether an RGBA16F framebuffer is `FRAMEBUFFER_COMPLETE`; and the texture size WebGL2 gives a `VideoFrame` built from an `ArrayBuffer` with `codedWidth: 1440, codedHeight: 1088, visibleRect: {x:0,y:0,width:1440,height:1080}, displayWidth: 1920, displayHeight: 1080` (upload with `texImage2D`, then a one-pixel draw whose fragment shader writes `vec4(textureSize(t,0), 0, 1) / 4096.0` into an RGBA16F target and `readPixels` it as FLOAT).
- [ ] **Step 2: Run it locally** on Chrome with the GPU (`npx playwright test -c spike/playwright.probe.config.ts`), then in Docker as CI would (`mcr.microsoft.com/playwright:v1.64.0-noble`, `npx playwright install chrome`, headless), first with default flags, then with `--use-angle=swiftshader --enable-unsafe-swiftshader`. Expected: a table of the five values for each run.
- [ ] **Step 3: Record findings.** In the spec: replace `v4.0.1` in §4.2 with the commit pin above and why; add to §3.3 which size `MAIN` takes for an anamorphic frame (visible 1440×1080 or display 1920×1080). If the upload gives the display size, MAIN is the display size and the spec says so as a deviation. In the plan's "Spike findings": whether CI needs launch flags (if so, Task 11 adds them to `playwright.config.ts` `launchOptions.args`, CI-only via `process.env.CI`) or whether shader E2E tests must skip on CI.
- [ ] **Step 4: Ask the user** whether to confirm on real CI by opening a draft PR from this branch (CI runs on `pull_request`). Do not push without that answer; if declined, rely on the Docker result.
- [ ] **Step 5: Commit** the spec and plan edits only.

```bash
git add docs/superpowers/specs/2026-10-15-video-shaders-design.md docs/superpowers/plans/2026-10-15-video-shaders.md
git commit -m "docs(shaders): spike findings, Anime4K pin"
```

---

## Task 2: Shader file parser and fixtures

**Files:**
- Create: `src/engine/shaders/parse.ts`, `src/engine/shaders/parse.test.ts`
- Create: `fixtures/shaders/basic/{passthrough,invert,nearest-x2,chain,when-skip,prekernel,luma-only,compute}.glsl`
- Create: `fixtures/shaders/anime4k/` with `LICENSE` (Anime4K's MIT text) and, from the pinned commit, `Anime4K_Clamp_Highlights.glsl`, `Anime4K_Restore_CNN_VL.glsl`, `Anime4K_Upscale_CNN_x2_VL.glsl`, `Anime4K_AutoDownscalePre_x2.glsl`, `Anime4K_AutoDownscalePre_x4.glsl`, `Anime4K_Upscale_CNN_x2_M.glsl`, `Anime4K_Restore_CNN_M.glsl`, `Anime4K_Upscale_CNN_x2_S.glsl`, and `README.md` naming the source URL and commit.

**Interfaces:**
- Produces:
  ```ts
  export interface ShaderPass {
    readonly file: string;          // file name it came from
    readonly index: number;         // pass number within the file, from 0
    readonly line: number;          // 1-based line of its first //! directive
    readonly desc: string;          // DESC, or `${file} #${index}`
    readonly hooks: readonly string[];
    readonly binds: readonly string[];
    readonly save: string | null;   // null = the hooked texture
    readonly width: string | null;  // raw RPN text; null = HOOKED.w
    readonly height: string | null;
    readonly when: string | null;
    readonly components: 1 | 2 | 3 | 4 | null;
    readonly body: string;
  }
  export class ShaderFileError extends Error { constructor(readonly file: string, readonly line: number, readonly reason: string) }
  export const FIRING_HOOKS: readonly string[]; // ['MAIN', 'MAINPRESUB', 'NATIVE', 'PREKERNEL']
  export function parseShaderFile(file: string, source: string): ShaderPass[];
  /** Null when the file can be added; else the reason shown to the user. */
  export function validateShaderFile(file: string, source: string, bytes: number): string | null;
  ```

Fixture contents (each a real mpv shader; keep them minimal): `passthrough` (`//!HOOK MAIN`, `//!BIND HOOKED`, `return HOOKED_tex(HOOKED_pos);`); `invert` (returns `vec4(1.0 - HOOKED_tex(HOOKED_pos).rgb, 1.0)`); `nearest-x2` (`//!WIDTH MAIN.w 2 *`, `//!HEIGHT MAIN.h 2 *`, `//!SAVE MAIN`, samples `HOOKED_texOff(0)`); `chain` (pass 1 `//!SAVE TINT` `//!COMPONENTS 1`, pass 2 `//!BIND HOOKED` `//!BIND TINT`); `when-skip` (`//!WHEN OUTPUT.w MAIN.w / 1.200 >`); `prekernel` (`//!HOOK PREKERNEL`); `luma-only` (`//!HOOK LUMA`); `compute` (`//!COMPUTE 16 16`).

- [ ] **Step 1: Fetch the Anime4K fixtures** from `https://raw.githubusercontent.com/bloc97/Anime4K/7684e9586f8dcc738af08a1cdceb024cc184f426/glsl/<dir>/<file>` and `.../LICENSE`; write the basic fixtures.
- [ ] **Step 2: Write the failing tests** in `parse.test.ts`:
  - `parses directives and defaults`: `chain.glsl` → 2 passes; pass 0 `{ hooks: ['MAIN'], binds: ['HOOKED'], save: 'TINT', components: 1, width: null }`; pass 1 `binds: ['HOOKED', 'TINT']`, `save: null`; `body` of each contains `vec4 hook()` and no `//!` line.
  - `keeps RPN text`: `nearest-x2.glsl` pass 0 `width === 'MAIN.w 2 *'`.
  - `tolerates CRLF, BOM and extra spaces`: `'﻿' + passthrough.replace(/\n/g, '\r\n').replace('//!HOOK MAIN', '//!HOOK  MAIN  ')` parses equal to the clean file (Review Focus 1).
  - `parses every Anime4K fixture`: each file in `fixtures/shaders/anime4k/*.glsl` parses; `Anime4K_Clamp_Highlights.glsl`'s last pass has `hooks: ['PREKERNEL']`; every pass of `Anime4K_Upscale_CNN_x2_VL.glsl` has `binds.length <= 16`.
  - `rejects unsupported directives with line numbers`: `compute.glsl` throws `ShaderFileError` with `reason` containing `COMPUTE` and the directive's line; same for a `//!TEXTURE`, `//!PARAM`, `//!BUFFER` block and `//!OFFSET`.
  - `validateShaderFile`: `luma-only.glsl` → `"this shader hooks only LUMA, which this player doesn't provide"`; a 4 MiB + 1 byte size → a reason containing `4 MiB`; a valid file → `null`; a file with no `//!HOOK` → a reason.
- [ ] **Step 3: Run** `npx vitest run src/engine/shaders/parse.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 4: Implement** `parse.ts`. A pass starts at a run of `//!` lines and its body runs to the next `//!` run. Strip a leading BOM, normalize CRLF, split each directive on whitespace. Unknown hook names are kept (they never fire, spec §3.3).
- [ ] **Step 5: Run** the test file. Expected: PASS.
- [ ] **Step 6: Commit.**

```bash
git add src/engine/shaders/parse.ts src/engine/shaders/parse.test.ts fixtures/shaders
git commit -m "feat(shaders): mpv user shader parser and fixtures"
```

---

## Task 3: RPN evaluator

**Files:**
- Create: `src/engine/shaders/rpn.ts`, `src/engine/shaders/rpn.test.ts`

**Interfaces:**
- Produces:
  ```ts
  /** Size lookup for `NAME.w`/`.width`/`.h`/`.height`; undefined = unknown texture. */
  export type SizeLookup = (name: string) => { readonly width: number; readonly height: number } | undefined;
  /** Throws RpnError on malformed text (stack underflow, leftovers, unknown token). Returns null when a name is unknown. */
  export function evalRpn(expr: string, lookup: SizeLookup): number | null;
  export class RpnError extends Error {}
  ```

- [ ] **Step 1: Write the failing tests:**
  - `'MAIN.w 2 *'` with MAIN 1920×1080 → `3840`; `'HOOKED.h 2 /'` with HOOKED 1080 high → `540`; `.width`/`.height` spellings equal `.w`/`.h`.
  - `'OUTPUT.w MAIN.w / 1.200 > OUTPUT.h MAIN.h / 1.200 > *'`: OUTPUT 3840×2160, MAIN 1920×1080 → `1`; OUTPUT 1920×1080 → `0`.
  - `'OUTPUT.w NATIVE.w / 2.0 < OUTPUT.w NATIVE.w / 1.2 > *'` (AutoDownscalePre_x2 style): ratio exactly 2.0 → `0`.
  - `%` → `7 3 %` = `1`; `!` → `0 !` = `1`, `5 !` = `0`; `=` → `1 1.0000001 =` = `1` and `1 2 =` = `0` (fuzzy compare: `Math.abs(a - b) < 1e-6`... use libplacebo's rule from `custom_mpv.c` and quote it in a comment).
  - `'FOO.w 2 *'` with FOO unknown → `null`; `'1 +'` → throws `RpnError`; `'1 2'` → throws.
- [ ] **Step 2: Run** `npx vitest run src/engine/shaders/rpn.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `evalRpn` (float stack; tokens split on whitespace; a token is a number, an operator, or `NAME.suffix`).
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shaders): RPN size and condition evaluator`.

---

## Task 4: Frame planner

**Files:**
- Create: `src/engine/shaders/plan.ts`, `src/engine/shaders/plan.test.ts`

**Interfaces:**
- Consumes: `ShaderPass` (Task 2), `evalRpn` (Task 3).
- Produces:
  ```ts
  export interface Size { readonly width: number; readonly height: number }
  /** id 0 is the uploaded frame (RGBA8); every pass output gets a new id. */
  export interface TexRef { readonly id: number; readonly width: number; readonly height: number; readonly components: 1 | 2 | 4 }
  export interface PlannedPass {
    readonly pass: ShaderPass;
    readonly stage: 'NATIVE' | 'MAIN' | 'PREKERNEL';
    readonly hooked: TexRef;
    /** In BIND order; `name` is the BIND text (HOOKED stays HOOKED). */
    readonly inputs: readonly { readonly name: string; readonly tex: TexRef }[];
    readonly out: TexRef;
    readonly saveAs: string;
  }
  export interface FramePlan { readonly passes: readonly PlannedPass[]; readonly final: TexRef; readonly output: Size }
  export function planFrame(passes: readonly ShaderPass[], source: Size, output: Size): FramePlan;
  ```

Semantics (spec §3.2–3.3): stages run NATIVE, then MAIN (`MAINPRESUB` is the same stage), then PREKERNEL; within a stage, passes run in set order; a pass hooking several firing stages runs in each. The table starts as `{ NATIVE: frame, MAIN: frame }`; a NATIVE-stage save to NATIVE also becomes MAIN's starting texture. `HOOKED` = the stage's current texture. In expressions `OUTPUT` = `output`, `NATIVE_CROPPED` = `source`, other names from the table. A pass is skipped when `WHEN` evaluates to 0 or null, or a BIND or size name is unknown. Size = `Math.round` of WIDTH/HEIGHT (defaults HOOKED's). Components = COMPONENTS (3 → 4) or HOOKED's. `SAVE` defaults to the stage name; saving replaces the table entry. PREKERNEL always fires once after MAIN on the current MAIN, and its result is `final`; with no PREKERNEL pass, `final` is the current MAIN.

- [ ] **Step 1: Write the failing tests** (fixtures read from disk, parsed with `parseShaderFile`):
  - `empty set`: `final.id === 0`, no passes.
  - `nearest-x2 doubles MAIN`: source 640×360 → one pass, `out` 1280×720, `final === out`.
  - `SAVE replaces by name and BIND sees the latest`: two `chain.glsl` copies in one set → the fourth pass's `TINT` input is the third pass's output.
  - `missing BIND skips`: a pass binding `NOPE` is absent from `passes`.
  - `WHEN sees sizes changing mid-chain`: `[nearest-x2, when-skip]` with source 640×360 and output 1280×720 → `when-skip` skipped (MAIN is now 1280); output 2560×1440 → it runs.
  - `PREKERNEL runs after MAIN`: `[prekernel, invert]` → order invert (MAIN) then prekernel; `final` is the prekernel output.
  - `Anime4K Mode A (Fast) plans`: the files of Mode A (Fast) (Clamp_Highlights, Restore_CNN_M, Upscale_CNN_x2_M, AutoDownscalePre_x2, AutoDownscalePre_x4, Upscale_CNN_x2_S) with source 1920×1080: output 1920×1080 → no pass from `Anime4K_Upscale_*` or `AutoDownscalePre_*` files, `final` 1920×1080; output 3840×2160 → Upscale_CNN_x2_M passes run, Upscale_CNN_x2_S passes and both AutoDownscalePre passes skipped, `final` 3840×2160; output 2560×1440 → Upscale_CNN_x2_M runs, AutoDownscalePre_x2 runs (ratio 1.33), its output 2560×1440, Upscale_CNN_x2_S skipped.
  - `resize changes the plan` (Review Focus 3): the same set planned at 1920×1080 and then 3840×2160 output gives different pass counts and `final` sizes; planning is pure (calling twice with equal input gives equal plans).
- [ ] **Step 2: Run** `npx vitest run src/engine/shaders/plan.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `planFrame`.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shaders): per-frame pass planner with libplacebo hook semantics`.

---

## Task 5: GLSL generation and the WebGL2 backend

**Files:**
- Create: `src/engine/shaders/codegen.ts`, `src/engine/shaders/codegen.test.ts`, `src/engine/shaders/webgl-backend.ts`
- Modify: `src/engine/NOTICE` (a section "libplacebo (LGPL-2.1-or-later): semantics followed, not ported" listing `shaders/plan.ts`, `shaders/codegen.ts` against `src/shaders/custom_mpv.c`, `src/renderer.c`; and "Anime4K (MIT, © 2019 bloc97)": built-in mode lists, fixtures)

**Interfaces:**
- Consumes: `ShaderPass`, `PlannedPass`, `FramePlan`, `planFrame`, `Size`.
- Produces:
  ```ts
  // codegen.ts
  export const VERTEX_SHADER: string;
  /** `hooked` is the stage name the pass runs at; samplers are `${BIND}_raw`, uniforms `${BIND}_size`, `${BIND}_pt`, plus `frame`, `random`, `input_size`, `target_size`, `tex_offset`. */
  export function fragmentSource(pass: ShaderPass, hooked: string): string;
  // webgl-backend.ts — also the ShaderBackend contract used by Task 6
  export interface CompiledSet { readonly passes: readonly ShaderPass[]; dispose(): void }
  export interface RenderResult { readonly image: OffscreenCanvas; readonly passesRun: number; readonly gpuMs: number | null }
  export class ShaderCompileError extends Error { constructor(readonly file: string, readonly pass: string, readonly log: string) }
  export interface ShaderBackend {
    compile(passes: readonly ShaderPass[]): Promise<CompiledSet>;   // rejects with ShaderCompileError
    render(set: CompiledSet, frame: VideoFrame, output: Size): RenderResult;
  }
  /** Returns the backend, or the reason shaders are unavailable. */
  export function createWebGlBackend(createCanvas: (w: number, h: number) => OffscreenCanvas, events: { lost(): void; restored(): void }): ShaderBackend | string;
  ```

- [ ] **Step 1: Write the failing `codegen.test.ts`:**
  - For `chain.glsl` pass 1 at stage `MAIN`: source starts with `#version 300 es`; declares `uniform sampler2D HOOKED_raw;` and `uniform sampler2D TINT_raw;`; defines `#define TINT_tex(pos) (TINT_mul * textureLod(TINT_raw, pos, 0.0))`, `#define TINT_texOff(off) TINT_tex(TINT_pos + TINT_pt * (off))`, `#define TINT_pos v_pos`; contains the pass body unchanged; ends with a `main()` assigning `hook()` to the `out vec4`.
  - `BIND MAIN` at stage MAIN also defines `HOOKED_tex`, `HOOKED_pos`, `HOOKED_size`, `HOOKED_pt` as aliases of the `MAIN_*` names; with no binding of HOOKED or the stage, no `HOOKED_` macros.
  - The number of `uniform sampler2D` lines equals `binds.length` (no extra sampler unit; spec §3.4).
  - Every pass of every Anime4K fixture only uses macros its source defines (Node cannot compile GLSL, so this catches missing macros instead): each identifier in the body matching `/\b([A-Za-z0-9_]+)_(tex|texOff|pos|size|pt|mul|raw|rot|off)\b/` has a prefix that is one of the pass's binds or `HOOKED`, and `fragmentSource` defines it.
- [ ] **Step 2: Run** `npx vitest run src/engine/shaders/codegen.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `codegen.ts` following libplacebo's `custom_mpv.c` macro definitions (`NAME_mul` 1.0 as a define, `NAME_rot` `mat2(1.0)`, `NAME_off` `vec2(0.0)`); `precision highp float; precision highp sampler2D;`.
- [ ] **Step 4: Run** the codegen tests. Expected: PASS.
- [ ] **Step 5: Implement** `webgl-backend.ts` (no unit test; exercised by Task 11 E2E):
  - One `OffscreenCanvas` WebGL2 context, `{ alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false }`; unavailable reason (Global Constraints copy) when no context or no `EXT_color_buffer_float`.
  - `compile`: create all programs, then wait on `COMPLETION_STATUS_KHR` (`KHR_parallel_shader_compile`) by polling each 16 ms with `setTimeout`, so the worker keeps rendering; on a failed link reject with `ShaderCompileError(file, desc, first line of the info log)`.
  - `render`: upload `frame` to texture id 0 (`texImage2D`, RGBA8, LINEAR, CLAMP_TO_EDGE); `planFrame(set.passes, sourceSize, output)` where `sourceSize` follows Task 1's finding; execute each `PlannedPass` into a pooled float texture (pool keyed by width×height×components, released at frame end); set uniforms; draw a full-screen triangle; finally resize the canvas to `output` and draw `final` with a bilinear pass to the default framebuffer. `frame` uniform counts pass executions across the session; `random` = a fresh `Math.random()` per pass.
  - `gpuMs`: `EXT_disjoint_timer_query_webgl2` when present (result read one frame late), else null.
  - `webglcontextlost` → `preventDefault()`, `events.lost()`, drop programs and textures; `webglcontextrestored` → `events.restored()`.
- [ ] **Step 6: Run** `npm run typecheck`. Expected: no errors.
- [ ] **Step 7: Commit** `feat(shaders): GLSL ES generation and WebGL2 backend`.

---

## Task 6: Shader stage, protocol and player

**Files:**
- Create: `src/engine/shaders/stage.ts`, `src/engine/shaders/stage.test.ts`
- Modify: `src/engine/protocol.ts`, `src/engine/render/compositor.ts`, `src/engine/render/compositor.test.ts`, `src/engine/player.ts`, `src/engine/player.test.ts`, `src/engine/worker.ts`

**Interfaces:**
- Consumes: `ShaderBackend`, `CompiledSet`, `ShaderCompileError`, `createWebGlBackend` (Task 5); `parseShaderFile`, `ShaderFileError` (Task 2).
- Produces (protocol):
  ```ts
  export interface ShaderSetData { readonly name: string; readonly files: readonly { readonly name: string; readonly source: string }[] }
  export type ShaderState = 'off' | 'compiling' | 'active' | 'error' | 'unavailable';
  // EngineCommand
  | { readonly type: 'setVideoShaders'; readonly set: ShaderSetData | null }
  // EngineEvent
  | { readonly type: 'shaderStatus'; readonly state: ShaderState; readonly set: string | null; readonly error: string | null }
  // Telemetry
  readonly shader: { readonly set: string; readonly passesRun: number; readonly gpuMs: number | null } | null;
  ```
- Produces (engine):
  ```ts
  export class ShaderStage {
    constructor(backend: ShaderBackend | string, onStatus: (s: { state: ShaderState; set: string | null; error: string | null }) => void, onReady: () => void);
    setSet(set: ShaderSetData | null): void;
    /** The shaded image for this frame at this output size, or null to draw the raw frame. Reuses the last result for the same frame and size. */
    process(frame: VideoFrame, output: Size): OffscreenCanvas | null;
    contextLost(): void;
    contextRestored(): void;
    readonly stats: { readonly set: string; readonly passesRun: number; readonly gpuMs: number | null } | null;
  }
  // compositor.ts
  interface CompositorLike { …; setShaderStage?(stage: ShaderStage | null): void }
  // PlayerDeps
  readonly createShaderBackend?: (events: { lost(): void; restored(): void }) => ShaderBackend | string;
  ```

Stage behaviour (spec §5): `setSet` parses all files (a `ShaderFileError` → state `error` with `"<file> line <n>: <reason>"`); the cache key is the set name plus a hash of each file's source (FNV-1a over the concatenated sources is enough) so re-added files recompile (Review Focus 5); while compiling, `process` returns the previous active set's output, or null if none, and status is `compiling`; a compile that resolves for a set no longer selected is cached but not activated; success → `active` and `onReady()`; failure → `error` with `"<file>, <pass>: <log>"`, process returns null. `setSet(null)` → `off`, `onReady()`. A backend string → every `setSet` reports `unavailable` with that string. Compiled sets live as long as the stage (the page), not the session.

- [ ] **Step 1: Write the failing `stage.test.ts`** with a fake `ShaderBackend` whose `compile` returns a deferred promise and whose `render` records calls and returns a sentinel canvas:
  - status sequence `compiling` → `active` for a valid set; `process` returns null while compiling, the sentinel after; `onReady` called once on activation.
  - `process` called twice with the same frame object and size renders once; a different size renders again (Review Focus 3).
  - switching A → B while B compiles keeps returning A's output; switching back to A after B is cached is immediate (`active` with no `compiling` status).
  - same name, changed source → recompiles (Review Focus 5).
  - parse error → `error` with file and line; compile rejection → `error` with file and pass.
  - backend unavailable → `unavailable` with the reason.
  - `contextLost()` → process returns null and status `error`; `contextRestored()` → recompiles the selected set and returns to `active`.
- [ ] **Step 2: Run** `npx vitest run src/engine/shaders/stage.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `stage.ts`.
- [ ] **Step 4: Run** the stage tests. Expected: PASS.
- [ ] **Step 5: Write the failing compositor and player tests:**
  - `compositor.test.ts`: with a stage stub whose `process` returns a canvas, `drawVideo(frame)` calls `drawImage(<stub canvas>, r.x, r.y, r.width, r.height)` with the `fitRect` of the frame's display size, passing `{ width: r.width, height: r.height }` as output; `frameSize`/`storageSize` still come from the frame (text placement unchanged); `process` returning null draws the frame as before.
  - `player.test.ts`: `setVideoShaders` sent before `attachCanvas` reaches the compositor's `setShaderStage` once the canvas attaches (Review Focus 2); a `close` then `open` keeps the selected set; `shaderStatus` events are emitted; when paused, `onReady` makes the next `tick()` call `drawVideo(presenter.current)` and the overlays after it (Review Focus 4); telemetry carries `shader` from `stage.stats`.
- [ ] **Step 6: Run** them. Expected: FAIL.
- [ ] **Step 7: Implement:**
  - `protocol.ts` additions above.
  - `Compositor.setShaderStage`; in `drawVideo`, `const image = this.stage?.process(frame, { width: r.width, height: r.height }) ?? frame` then `drawImage(image, …)`.
  - `Player`: a `ShaderStage` created lazily on the first `setVideoShaders` (so no WebGL context exists until a set is chosen), from `deps.createShaderBackend?.(events) ?? 'Shaders are unavailable here'`; handed to the current compositor when created and to each new compositor in `attachCanvas`; `onReady` sets a `shadersDirty` flag that `paint` ORs into `changed` like `subtitlesDirty`; status → `emit({ type: 'shaderStatus', … })`; telemetry `shader: this.shaderStage?.stats ?? null`.
  - `worker.ts`: `createShaderBackend: (events) => createWebGlBackend((w, h) => new OffscreenCanvas(w, h), events)`.
- [ ] **Step 8: Run** `npm test` and `npm run typecheck`. Expected: PASS, no errors.
- [ ] **Step 9: Commit** `feat(shaders): shader stage in the compositor, protocol and player`.

---

## Task 7: Controller, reducer and drop meter

**Files:**
- Create: `src/player/drop-meter.ts`, `src/player/drop-meter.test.ts`
- Modify: `src/player/player-controller.ts`, `src/player/player-controller.test.ts`

**Interfaces:**
- Consumes: `ShaderSetData`, `ShaderState`, `shaderStatus`, `Telemetry.shader` (Task 6).
- Produces:
  ```ts
  // drop-meter.ts
  export const DROP_WINDOW_MS = 5_000;
  export const DROP_WARN_RATE = 0.05;
  export class DropMeter {
    push(nowMs: number, presented: number, dropped: number): void;
    /** Dropped ÷ (presented + dropped) over the window; null with under 1 s of samples. */
    rate(): number | null;
    reset(): void;
  }
  // PlayerSnapshot
  readonly shaders: { readonly state: ShaderState; readonly set: string | null; readonly error: string | null };
  /** Drop rate while a set is active and the rate is above DROP_WARN_RATE; else null. */
  readonly shaderDropWarning: number | null;
  // PlayerController
  setShaderSet(set: ShaderSetData | null): void;
  ```

- [ ] **Step 1: Write the failing tests:**
  - `drop-meter.test.ts`: counters rising 120 presented / 0 dropped per second → rate 0; 100 presented / 20 dropped per second → `20/120`; samples older than 5 s leave the window; a counter going down (new session) resets the window; under 1 s of data → null.
  - `player-controller.test.ts`: `reduceEvent` maps `shaderStatus` into `shaders`; `INITIAL_SNAPSHOT.shaders` is `{ state: 'off', set: null, error: null }`; `setShaderSet` posts `{ type: 'setVideoShaders', set }`; with `shaders.state === 'active'`, telemetry with a 20 % drop over 5 s sets `shaderDropWarning ≈ 0.2`, 2 % leaves it null, and a `shaderStatus` of `off` clears it and resets the meter.
- [ ] **Step 2: Run** `npx vitest run src/player`. Expected: FAIL.
- [ ] **Step 3: Implement.** The meter is fed in the controller's `onmessage` for `telemetry` events (using `performance.now()` injected as a constructor option defaulting to it, so tests pass times), not in the pure `reduceEvent`.
- [ ] **Step 4: Run** `npx vitest run src/player`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shaders): controller command, status and frame-drop warning`.

---

## Task 8: Built-in Anime4K sets and `input.conf` import

**Files:**
- Create: `src/ui/shader-sets.ts`, `src/ui/shader-sets.test.ts`
- Create: `src/ui/anime4k/input-hq.conf` (from `md/Template/GLSL_Mac_Linux_High-end/input.conf` at the pinned commit), `src/ui/anime4k/input-fast.conf` (from `GLSL_Mac_Linux_Low-end`), `src/ui/anime4k/LICENSE`, `src/ui/anime4k/README.md` (source URL and commit)

**Interfaces:**
- Produces:
  ```ts
  export interface ShaderSetDef { readonly name: string; readonly files: readonly string[]; readonly origin: 'anime4k' | 'imported' }
  export interface SetEntry extends ShaderSetDef { readonly missing: readonly string[]; readonly available: boolean }
  export function parseInputConf(text: string): ShaderSetDef[];   // origin 'imported'
  export const BUILT_IN_SETS: readonly ShaderSetDef[];          // parseInputConf of the two templates (`?raw` imports), origin 'anime4k'
  /** Built-ins shown once any of their files is in the library; imported always shown; imported lists equal to a built-in's dropped. Order: built-in HQ then Fast in template order, then imported in import order. */
  export function resolveSets(imported: readonly ShaderSetDef[], library: ReadonlySet<string>): SetEntry[];
  export function missingLabel(missing: readonly string[]): string; // "missing: X" / "missing: X +2 more"
  ```

- [ ] **Step 1: Copy the templates** byte for byte from the pinned commit.
- [ ] **Step 2: Write the failing tests:**
  - `BUILT_IN_SETS` has 12 entries; the first is `{ name: 'Anime4K: Mode A (HQ)', files: ['Anime4K_Clamp_Highlights.glsl', 'Anime4K_Restore_CNN_VL.glsl', 'Anime4K_Upscale_CNN_x2_VL.glsl', 'Anime4K_AutoDownscalePre_x2.glsl', 'Anime4K_AutoDownscalePre_x4.glsl', 'Anime4K_Upscale_CNN_x2_M.glsl'] }`; the seventh is `'Anime4K: Mode A (Fast)'` ending in `Anime4K_Upscale_CNN_x2_S.glsl`.
  - `parseInputConf` of the Windows template text (`;` separators; inline it in the test) equals the Mac/Linux one; `glsl-shaders clr` lines and comments yield nothing; a line `F1 change-list glsl-shaders set "a.glsl:b.glsl"` with no `show-text` is named `F1`; `glsl-shaders set "~~/shaders/x.glsl"` without `change-list` is accepted.
  - `resolveSets`: with an empty library no built-ins show; with only `Anime4K_Clamp_Highlights.glsl` all 12 show, unavailable, `missing[0]` is the first absent file; with all Mode A (Fast) files, that set is `available`; an imported set identical to Mode A (HQ) is dropped.
  - `missingLabel(['a', 'b', 'c'])` → `'missing: a +2 more'`.
- [ ] **Step 3: Run** `npx vitest run src/ui/shader-sets.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** `shader-sets.ts`.
- [ ] **Step 5: Run** the tests. Expected: PASS.
- [ ] **Step 6: Commit** `feat(shaders): built-in Anime4K modes and input.conf import`.

---

## Task 9: Library storage and the shader model

**Files:**
- Create: `src/ui/db.ts`, `src/ui/shader-library.ts`, `src/ui/shader-library.test.ts`, `src/ui/shader-model.ts`, `src/ui/shader-model.test.ts`
- Modify: `src/ui/recent-discs.ts` (use `db.ts`), `src/ui/recent-discs.test.ts` (still passes; add a v2→v3 upgrade test)

**Interfaces:**
- Consumes: `validateShaderFile` (Task 2), `parseInputConf`, `resolveSets`, `BUILT_IN_SETS`, `SetEntry` (Task 8), `ShaderSetData` (Task 6), `PlayerSnapshot.shaders` (Task 7).
- Produces:
  ```ts
  // db.ts — the one place the `bluray-web` database is opened (version 3)
  export const STORES: { readonly recentDiscs: 'recent-discs-v2'; readonly shaderFiles: 'shader-files'; readonly shaderSets: 'shader-sets'; readonly settings: 'settings' };
  export function withStore<T>(factory: IDBFactory, store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined>;
  // shader-library.ts
  export interface StoredShaderFile { readonly name: string; readonly source: string; readonly addedAt: number }
  export interface ShaderLibrary {
    files(): Promise<StoredShaderFile[]>;
    putFiles(files: readonly StoredShaderFile[]): Promise<void>;
    removeFile(name: string): Promise<void>;
    importedSets(): Promise<ShaderSetDef[]>;
    putImportedSets(sets: readonly ShaderSetDef[]): Promise<void>; // replaces sets of the same name
    removeImportedSet(name: string): Promise<void>;
    selected(): Promise<string | null>;
    setSelected(name: string | null): Promise<void>;
  }
  export function idbShaderLibrary(factory?: IDBFactory): ShaderLibrary;
  // shader-model.ts — main-thread state for the menu, an external store like PlayerController
  export interface AddReport { readonly added: readonly string[]; readonly rejected: readonly { readonly name: string; readonly reason: string }[]; readonly importedSets: number }
  export interface ShaderModelState { readonly sets: readonly SetEntry[]; readonly files: readonly string[]; readonly imported: readonly string[]; readonly selected: string | null; readonly selectedMissing: boolean; readonly report: AddReport | null }
  export class ShaderModel {
    constructor(library: ShaderLibrary, apply: (set: ShaderSetData | null) => void, now?: () => number);
    load(): Promise<void>;                       // reads the library; applies the saved selection if available
    select(name: string | null): Promise<void>;
    cycle(): Promise<void>;                       // Off → each available set → Off
    add(files: readonly { readonly name: string; readonly text: () => Promise<string>; readonly size: number }[]): Promise<void>;
    removeFile(name: string): Promise<void>;
    removeSet(name: string): Promise<void>;
    dismissReport(): void;
    subscribe(listener: () => void): () => void;
    getSnapshot(): ShaderModelState;
  }
  ```

`add` takes base names (strip any folder path), keeps `.glsl` files that pass `validateShaderFile`, imports any file named `input.conf`, ignores everything else silently, and re-applies the selected set if one of its files changed (Review Focus 5). `load` with a saved selection that is no longer available leaves `selected` set and `selectedMissing: true`, and applies nothing (spec §10 settled calls).

- [ ] **Step 1: Write the failing tests** with `fake-indexeddb`'s `IDBFactory`:
  - `shader-library.test.ts`: put/list/remove files; re-putting a name replaces its source; imported sets replace by name; selection round-trips; a database created at version 2 by the old `recent-discs.ts` code (create it in the test with `factory.open('bluray-web', 2)` and the `recent-discs-v2` store holding one row) upgrades to 3 keeping that row.
  - `shader-model.test.ts` with an in-memory `ShaderLibrary` and an `apply` spy: adding the Mode A (Fast) fixture files makes that set available; `select` applies `{ name, files: [{ name, source }…] }` in set order and persists; `cycle` from Off picks the first available set, then the next, then Off (`apply(null)`); a rejected file appears in `report.rejected` with its reason; an `input.conf` creates imported sets and counts them; `load` with a saved available set applies it; with a missing file sets `selectedMissing` and applies nothing; re-adding an active set's file with new text applies again with the new source; `removeFile` of an active set's file applies `null` and marks it missing.
- [ ] **Step 2: Run** `npx vitest run src/ui/shader-library.test.ts src/ui/shader-model.test.ts src/ui/recent-discs.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `db.ts` (move `openDb`/`withStore` out of `recent-discs.ts`; `onupgradeneeded` creates any missing store and keeps deleting the legacy `recent-discs` store), `shader-library.ts`, `shader-model.ts`.
- [ ] **Step 4: Run** the same tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shaders): IndexedDB shader library and menu model`.

---

## Task 10: Shaders menu, manager and key

**Files:**
- Create: `src/ui/ShaderMenu.tsx`
- Modify: `src/ui/App.tsx` (one `ShaderModel` per app, `load()` on mount, `apply` = `controller.setShaderSet`), `src/ui/PlayerScreen.tsx`, `src/ui/ControlBar.tsx`, `src/ui/keyboard.ts`, `src/ui/keyboard.test.ts`, `src/ui/styles.css`

**Interfaces:**
- Consumes: `ShaderModel`, `ShaderModelState`, `missingLabel` (Tasks 8–9); `PlayerSnapshot.shaders`, `shaderDropWarning` (Task 7).
- Produces: `KeyAction` gains `{ readonly type: 'cycleShaders' }`; test ids `shader-menu` (button), `shader-add-folder` (hidden `<input type="file" webkitdirectory>`), `shader-add-files` (hidden `<input type="file" multiple accept=".glsl,.conf">`), `shader-manage`, `shader-warning`, `shader-report`.

- [ ] **Step 1: Write the failing keyboard test:** `keyToAction('v')` and `keyToAction('V')` → `{ type: 'cycleShaders' }`, also while `menuActive`; `keyActionUo` of it → null.
- [ ] **Step 2: Run** `npx vitest run src/ui/keyboard.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the key, and `PlayerScreen`'s `case 'cycleShaders': void model.cycle()`.
- [ ] **Step 4: Run** the keyboard tests. Expected: PASS.
- [ ] **Step 5: Implement `ShaderMenu`** modelled on `AudioMenu` (same open/close, focus, arrow-key and `onOpenChange` handling), shown always (not only with >1 item):
  - `menuitemradio` items: `Off`, then each shown `SetEntry`; unavailable ones disabled with the `missingLabel` text as a second line; the item matching `snapshot.shaders.set` while `state === 'compiling'` shows `Compiling…`; `state === 'error'` shows the error under the selected item; `selectedMissing` shows the saved name disabled with its missing label.
  - `Add shaders…` opens `shader-add-folder`; a second action `Add files…` opens `shader-add-files`; both call `model.add` with the picked `File`s (`{ name: f.name, size: f.size, text: () => f.text() }`).
  - `Manage…` opens a dialog (`role="dialog"`) listing files and imported sets with a Remove button each.
  - After an add, a dismissible `shader-report` lists added count, imported set count and each rejected file with its reason.
  - When `snapshot.shaders.state === 'unavailable'`, the menu holds only the unavailable message (Global Constraints copy).
  - When `snapshot.shaderDropWarning !== null`, the button carries a `⚠` mark (`shader-warning`) and the menu shows the warning line.
- [ ] **Step 6: Wire** `ShaderMenu` into `ControlBar` after `SubtitleMenu`, passing the model state from `useSyncExternalStore(model.subscribe, model.getSnapshot)` in `App` down through `PlayerScreen`.
- [ ] **Step 7: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 8: Commit** `feat(shaders): Shaders menu, manager and v key`.

---

## Task 11: End-to-end tests

**Files:**
- Create: `tests/e2e/shaders.spec.ts`
- Modify: `playwright.config.ts` only if Task 1 found CI needs launch flags

**Interfaces:**
- Consumes: test ids from Task 10; telemetry `shader` (Task 6); `fixtures/shaders/` (Task 2); `decodePng` from `tests/ass-trace/png.ts`; `fixtures/synthetic/disc1` (640×360, `testsrc2`) and `disc-subs`.

All tests open the disc with `?telemetry=1`, add shaders through `shader-add-files` with `setInputFiles`, and pause before screenshots of `video-canvas`. A `beforeEach` probes WebGL2 + `EXT_color_buffer_float` in a worker (Task 1's probe code) and `test.skip`s with the reason when missing. The `Anime4K` and sync tests run only with `SHADERS_GPU=1`.

- [ ] **Step 1: Write the tests:**
  - `pass-through matches Off`: screenshot with Off, then with a set containing only `passthrough.glsl` → `pixelmatch` differing pixels under 0.5 % at threshold 0.1 (spec §3.5).
  - `invert inverts`: the centre pixel's RGB with `invert.glsl` is within 8 of `255 − Off`.
  - `subtitles stay unshaded`: on `disc-subs`, paused at 2.0 s (English PG caption on) with invert active; screenshot with subtitles on and off; at least 90 % of the pixels that differ have luma > 200.
  - `nearest-x2 and WHEN`: with `[nearest-x2, when-skip]` and the default viewport, telemetry `shader.passesRun` is 1 (MAIN is doubled to the output size, so `when-skip` is skipped); after `page.setViewportSize` to twice the size, it becomes 2 (Review Focus 3).
  - `persists across a reload`: add `invert.glsl` and an `input.conf` whose only line is `CTRL+1 change-list glsl-shaders set "~~/shaders/invert.glsl"; show-text "Invert"`, pick `Invert`, reload, reopen the disc → `shaderStatus` active with set `Invert` (read through the menu's checked item) and the centre pixel inverted.
  - `paused switch repaints` (Review Focus 4): pause, choose invert → the screenshot changes within 2 s without resuming.
  - `SHADERS_GPU`: `Anime4K Mode A (Fast)` with `fixtures/shaders/anime4k/*.glsl` added → telemetry `shader.set === 'Anime4K: Mode A (Fast)'`, `passesRun > 0`, `framesPresented` rising over 3 s; and the existing sync assertion (`collectWindows` + `SYNC_TOLERANCE_US`/`MAX_ABS_TOLERANCE_US` from `tests/e2e/telemetry.ts`) holds on `disc1` with `passthrough.glsl` active.
- [ ] **Step 2: Run** `npm run test:e2e -- shaders` locally, then `SHADERS_GPU=1 npx playwright test shaders`. Expected: all pass (or the CI-only ones skip with the logged reason when forced to software GL as in Task 1).
- [ ] **Step 3: Run the whole suite** `npm run test:e2e`. Expected: PASS (shaders off must not change existing results).
- [ ] **Step 4: Commit** `test(shaders): end-to-end shader tests`.

---

## Task 12: Docs and the real-machine gate

**Files:**
- Modify: `CLAUDE.md` (a "Shaders" paragraph under Architecture naming `engine/shaders/` and `ui/shader-*`; `SHADERS_GPU=1` under Commands), `docs/known-issues.md` (bilinear final scaler vs mpv's Lanczos; PREKERNEL in gamma light; GLSL ES 3.00 rejects desktop-GLSL habits such as implicit int→float, so some non-Anime4K shaders fail to compile; unsupported directives; the anamorphic MAIN size from Task 1), spec Status line → Implemented, with any deviations.

- [ ] **Step 1: Write the docs edits.** Leave the parent design spec alone (BD-J's worktree also edits shared docs; keep edits to these files small and append-only to ease the merge).
- [ ] **Step 2: Run** `npm run typecheck && npm test && npm run test:e2e`. Expected: PASS.
- [ ] **Step 3: Commit** `docs(shaders): CLAUDE.md, known issues, spec status`.
- [ ] **Step 4: Real-machine gate (with the user).** On the user's Mac with a real anime disc: Anime4K Mode A (HQ) and A (Fast) windowed and fullscreen; image visibly processed when upscaling; telemetry A/V offset within the usual bounds; drop rate and warning sensible; switch sets during playback, while paused and across a seek; reload keeps the choice. Record results in the spec's Status line.

---

## Spike findings

(Filled in by Task 1.)
