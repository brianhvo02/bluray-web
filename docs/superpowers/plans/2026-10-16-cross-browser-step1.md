# Cross-Browser, Mobile and Offline (Step 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The player opens and plays local discs (HDMV and BD-J) in Chrome, Safari (macOS, iOS, iPadOS), Firefox desktop and Chrome Android, works by touch, and installs as an offline app, without changing desktop Chromium behaviour.

**Architecture:** Per-feature capability detection replaces the Chromium gate. Small platform adapters (fullscreen, audio session, wake lock, media session, folder drop) sit behind injectable interfaces like the existing `PlayerDeps`/`AudioOutputLike`. A memory profile chosen by the UI and sent to the worker scales the engine's caches. A service worker built with `vite-plugin-pwa` (injectManifest) caches the app and re-adds the isolation headers.

**Tech Stack:** TypeScript (strict), React 19, Vite, Vitest, Playwright (chromium, webkit, firefox projects), `vite-plugin-pwa` + Workbox precaching.

**Spec:** `docs/superpowers/specs/2026-10-16-cross-browser-and-remote-design.md` §3 (step 1 only). Read §2 and §8 too.

**Precondition:** do not start until milestone 5 (BD-J, all sub-milestones) is merged into `main`. Then rebase this branch onto `main`. Line numbers below are from `f387ebe` and will have moved; find the code by the names given.

## Global Constraints

- Minimum versions: Safari 26 (macOS and iOS); Chrome and Firefox current stable minus two. Firefox Android is unsupported, with a message.
- No user-agent sniffing, except documented exceptions in `docs/known-issues.md` with a bug link. (The iPadOS check in Task 6 is one; record it.)
- Desktop Chromium behaviour is unchanged: every existing unit, E2E, vm-trace, bdj-trace and ass-trace test passes unchanged. A/V sync bounds 20 ms mean / 50 ms max.
- `src/engine/` stays free of React, `src/ui/` and `src/player/` imports. New browser APIs go behind injectable interfaces.
- COOP `same-origin` + COEP `require-corp` on every response, online and offline.
- Hit targets at least 44 CSS px on touch devices.
- Constrained memory profile values: IG sub-path preload 64 MB; ASS event / layer / mask caches 32 / 32 / 16 MB; ASS text supersampling at most 4× per side; decoded frame queue 4 for streams 3840 px wide or more.
- Copy (exact strings):
  - IG over the limit: `This disc's menus need more memory than this device allows.`
  - Hidden-page pause: `Playback paused while the app was in the background.`
  - HEVC missing: `This device can't decode HEVC (4K) video.`
  - Shaders missing: `Not available on this device`

## Review Focus

1. **A disc folder picked on iOS whose `webkitRelativePath` is empty or rooted differently** (Files app picks). Expected: the disc still opens; Task 4 tests `collectFromFileList` with `webkitRelativePath === ''` and with a path rooted at `BDMV`.
2. **The page hidden and shown again on desktop Chrome while playing.** Expected: playback continues, no notice. Task 8 tests that a hidden page with a running `AudioContext` does not pause.
3. **A tap on a disc menu while the controls are hidden.** Expected: the menu button activates (the tap goes to the menu, not to "show controls"). Task 10 tests the classifier for `menuActive: true`.
4. **The service worker serving an old `index.html` after a deploy, during playback.** Expected: no reload while playing; the update prompt appears. Task 14 tests that the prompt waits while `engineState` is `playing`.
5. **HEVC reported supported by `isConfigSupported` but failing to decode** (WebKit bug 262950). Expected: the existing decode-error path reports the HEVC message, not a generic failure. Task 3 tests that a decoder error on the first HEVC frame maps to the HEVC message.

---

### Task 1: Device probe page and early go/no-go checks

A page the user opens on iPhone and iPad (over HTTPS) that measures what this plan depends on, so later tasks know which branches apply.

**Files:**
- Create: `probe.html`, `src/probe/main.ts`, `src/probe/checks.ts`, `src/probe/checks.test.ts`, `src/probe/probe-worker.ts`
- Create: `.github/workflows/preview.yml` (lands on `main` first, Step 0)
- Modify: `vite.config.ts` (second build input `probe.html`)

**Interfaces:**
- Produces: `interface ProbeResult { readonly name: string; readonly ok: boolean; readonly detail: string }`; `runChecks(env: ProbeEnv): Promise<ProbeResult[]>` where `ProbeEnv` injects `pickFolder(): Promise<File[]>`, `createAudioContext(): BaseAudioContext`, `worker(): Promise<WorkerProbe>`, `globals: Record<string, unknown>`; `interface WorkerProbe { readonly hevc: { hvc1: boolean; hev1: boolean; decoded: boolean } | null; readonly raf: { present: boolean; p95Ms: number }; readonly webgl: { float: boolean; half: boolean } }` (`hevc` is null when the folder has no HEVC clip).

- [ ] **Step 0: Preview deploys from CI.** Add `.github/workflows/preview.yml`:
  - Trigger: `workflow_dispatch` only, with no inputs; the branch to deploy is the run's ref.
  - Job: the same setup as the `deploy` job in `ci.yml` (Node 24, `npm install -g npm@11.19.0`, `npm ci`, `npm run build`, `test -f dist/_headers`).
  - Deploy: `cloudflare/wrangler-action@v3` with the existing `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets and `command: pages deploy dist --project-name=bluray-web --branch=${{ github.ref_name }}`.
  - It must refuse `main` (`if: github.ref_name != 'main'`): production deploys stay in `ci.yml`, gated on the tests.
  - The job summary prints the preview URL, `https://<branch alias>.bluray-web.pages.dev`. Cloudflare lowercases the branch and replaces `/` and other non-alphanumerics with `-`; print the alias from wrangler's output rather than computing it.

  GitHub only offers `workflow_dispatch` for workflows on the default branch, so open this file as its own small PR to `main` (`ci: manual preview deploys`), merge it, then rebase this branch.

  Verify with `gh workflow run preview.yml --ref spec/cross-browser-remote`, then `gh run watch`. Expected: the run succeeds and the printed URL serves the app with `crossOriginIsolated === true` (check with `curl -sI <url> | grep -i cross-origin`).

- [ ] **Step 1: Write failing tests** in `src/probe/checks.test.ts` with a fake `ProbeEnv`:
  - `largeFileRead`: given a fake `File` of size `5 * 2**30` whose `slice(a, b).arrayBuffer()` returns bytes encoding `a`, the result for `'blob-slice-over-4gib'` is `ok: true` and `detail` contains the offset read (`4294967296` or above). A fake that returns the bytes of `a % 2**32` gives `ok: false`.
  - `sampleRate`: a fake context with `sampleRate: 44100` gives `{ name: 'audio-sample-rate', ok: false, detail: '44100' }`; `48000` gives `ok: true`.
  - `hevc`: `worker().hevc` returning `{ hvc1: true, hev1: false, decoded: true }` gives `ok: true` with detail `hvc1`.
- [ ] **Step 2: Run** `npx vitest run src/probe/checks.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `runChecks`.** Checks, in this order, each a `ProbeResult`:
  - `blob-slice-over-4gib`: reads 192 bytes at the largest offset above 2^32 in the biggest `.m2ts` of the picked folder and checks for the TS sync byte `0x47` at byte 4.
  - `audio-sample-rate`: `new AudioContext({ sampleRate: 48000 })` reports 48000.
  - `audio-session`: `'audioSession' in navigator`.
  - `worker-raf`: the worker has `requestAnimationFrame`; detail is the p95 interval over 120 ticks of whichever timer is used.
  - `hevc`: the worker runs `isConfigSupported` for the `hvc1.` and `hev1.` strings of the first HEVC clip in the folder (demuxed with the engine's `M2tsReader`) and decodes its first GOP.
  - `webgl2-float`: in the worker, `EXT_color_buffer_float` and `EXT_color_buffer_half_float`.
  - `canvas-filter`: `'filter' in OffscreenCanvasRenderingContext2D.prototype`, and blur visibly changes pixels.
  - `letter-spacing`: same pattern for `letterSpacing`.
  - `fullscreen`: `document.fullscreenEnabled`.
  - `webkitdirectory`: `'webkitdirectory' in HTMLInputElement.prototype`.

  `src/probe/main.ts` renders a "Pick a disc folder" button (`<input type=file webkitdirectory multiple>`), then the results as a table and a "Copy as JSON" button.
- [ ] **Step 4: Run** the tests again. Expected: PASS. `npm run build` emits `dist/probe.html`.
- [ ] **Step 5: Commit** `feat(probe): device capability probe page`.
- [ ] **Step 6 (user, manual): run the probe on devices.** Deploy this branch with `gh workflow run preview.yml --ref <this branch>` (Step 0); no local Cloudflare login is needed. Open `<preview URL>/probe.html` on the iPhone and iPad and pick a disc folder from the USB drive in Files. Do the same on Safari macOS, Firefox desktop and the Android emulator. Also open a BD-J disc in the main app on the iPhone with `?telemetry=1` and record its time from open to first frame against M5's target.
- [ ] **Step 7: Record results** in a new "Device probe results (date)" table in `docs/known-issues.md`.

  These results decide:
  - whether Task 7 Step 3 (resampling) runs;
  - whether Task 12 needs the half-float branch;
  - whether Task 13's letter-spacing fallback is needed;
  - whether rAF smoothness needs Task 9 Step 4;
  - whether a BD-J performance fix in the JVM is needed before the gate (if so, stop and raise it with the user: it is a separate piece of work).

  A failed `blob-slice-over-4gib` becomes a known issue naming the platform.
- [ ] **Step 8: Commit** `docs: device probe results`.

### Task 2: Per-feature capability report

**Files:**
- Modify: `src/ui/capabilities.ts`, `src/ui/capabilities.test.ts`, `src/ui/LandingScreen.tsx`

**Interfaces:**
- Produces:
  ```ts
  interface CapabilityReport {
    readonly core: { readonly ok: boolean; readonly missing: readonly string[] };
    readonly canPickDirectory: boolean;      // showDirectoryPicker
    readonly canPickFolderInput: boolean;    // webkitdirectory
    readonly canRememberDiscs: boolean;      // FileSystemHandle permissions (recents)
    readonly fullscreen: 'standard' | 'webkit' | null;
    readonly audioSession: boolean;
    readonly wakeLock: boolean;
    readonly mediaSession: boolean;
  }
  checkCapabilities(g?: Record<string, unknown>): CapabilityReport
  ```
  Later tasks read these fields. `ok`/`missing` move under `core`.

- [ ] **Step 1: Write failing tests:**
  - A Firefox-Android-like global (no `VideoDecoder`) gives `core.ok === false` with `missing` containing `'WebCodecs video decoding'`.
  - A Safari-like global (no `showDirectoryPicker`, has `webkitdirectory`, `document.webkitFullscreenEnabled` only) gives `core.ok === true`, `canPickDirectory: false`, `canPickFolderInput: true`, `fullscreen: 'webkit'`.
  - A global with `document.fullscreenEnabled === false` (iPhone) gives `fullscreen: null`.
- [ ] **Step 2: Run** `npx vitest run src/ui/capabilities.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `canRememberDiscs` is true when `FileSystemHandle.prototype.queryPermission` exists.
  - In `LandingScreen`, the banner reads `This browser is missing: {missing}. Use Chrome, Edge, Safari or Firefox (desktop), or Chrome on Android.` instead of the Chrome-only sentence.
  - The open button is disabled only by `!core.ok`.
- [ ] **Step 4: Run** the tests and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): per-feature capability report`.

### Task 3: HEVC codec string variants and the HEVC message

**Files:**
- Modify: `src/engine/decode/hevc.ts`, `src/engine/decode/video-decoder.ts`, and their `.test.ts` files

**Interfaces:**
- Produces: `hevcCodecStrings(sps: Uint8Array): readonly [string, string]`, which returns the `hvc1.` form, then the `hev1.` form. The `CODECS` ops gain `codecStrings(sps): readonly string[]`; H.264 returns its single string.

- [ ] **Step 1: Write failing tests:**
  - `hevcCodecStrings(sps)` equals `[expected.replace(/^hev1/, 'hvc1'), expected]`, where `sps` and `expected` are the fixture and value of the existing `hevcCodecString` test.
  - `configure` with a fake API that supports only `hev1.*` opens with `hev1`.
  - With a fake API that supports neither, `configure` throws `UnsupportedCodecError` whose message is `This device can't decode HEVC (4K) video.`
  - With a fake decoder that errors on every HEVC chunk, the fatal `DecoderError` (after more than 3 consecutive errors) carries the same message (Review Focus 5).
- [ ] **Step 2: Run** `npx vitest run src/engine/decode`. Expected: FAIL.
- [ ] **Step 3: Implement.** `configure` tries each string in order with `isConfigSupported` and uses the first that is supported. The H.264 message stays as it is.
- [ ] **Step 4: Run** the tests. Expected: PASS. All of `npm test` still passes.
- [ ] **Step 5: Commit** `feat(decode): try hvc1 and hev1 HEVC codec strings`.

### Task 4: Folder picking and drops on every browser

**Files:**
- Create: `src/ui/entry-walk.ts`, `src/ui/entry-walk.test.ts`
- Modify: `src/player/drop-files.ts` (use the shared walker), `src/ui/disc-input.ts`, `src/ui/disc-input.test.ts`, `src/ui/LandingScreen.tsx`

**Interfaces:**
- Produces:
  - `walkEntries(entries: readonly EntryLike[], maxDepth: number): Promise<Array<[string, File]>>`. Paths join entry names with `/` from the dropped entry's name; `EntryLike` is the `webkitGetAsEntry` shape now private in `drop-files.ts`.
  - `discFromDataTransfer(dt: DataTransfer): Promise<{ kind: 'handle'; handle: FileSystemDirectoryHandle } | { kind: 'entries'; entries: DiscEntries } | null>`. It uses `getAsFileSystemHandle` when present, else `webkitGetAsEntry` with `maxDepth` 6. It must be called synchronously in the drop handler.
- Consumes: `CapabilityReport.canRememberDiscs` (Task 2).

- [ ] **Step 1: Write failing tests:**
  - `walkEntries` on a fake tree `DISC/BDMV/{index.bdmv, PLAYLIST/00000.mpls}` returns `[['DISC/BDMV/index.bdmv', …], ['DISC/BDMV/PLAYLIST/00000.mpls', …]]`. It calls `readEntries` until it returns an empty batch.
  - `discFromDataTransfer` with items lacking `getAsFileSystemHandle` returns `kind: 'entries'`.
  - `collectFromFileList` keeps `f.name` when `webkitRelativePath === ''`, and keeps `BDMV/...` paths rooted at `BDMV` (Review Focus 1). Then `normalizeDiscPaths` opens a fixture listed that way (use `fixtures/synthetic/disc1` file names).
  - `drop-files.test.ts` keeps passing unchanged.
- [ ] **Step 2: Run** `npx vitest run src/ui src/player/drop-files.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.**
  - The landing drop handler uses `discFromDataTransfer`. `kind: 'entries'` calls `controller.open(entries)` directly, with no recents.
  - The "Recent discs" section renders only when `canRememberDiscs`.
  - `onPickFolder` uses the input when `!canPickDirectory`, as today.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): folder drops and picks without the File System Access API`.

### Task 5: Memory profile

**Files:**
- Create: `src/engine/memory-profile.ts`, `src/engine/memory-profile.test.ts`, `src/ui/memory-profile.ts`, `src/ui/memory-profile.test.ts`
- Modify:
  - `src/engine/protocol.ts`: command `{ type: 'setMemoryProfile'; profile: MemoryProfileName }`
  - `src/engine/player.ts`: `PRELOAD_SIZE_LIMIT`, `MAX_QUEUED_FRAMES`
  - `src/engine/ass/renderer.ts`: cache constants → `AssRendererDeps.limits`
  - `src/engine/ass/raster.ts`: `MAX_TEXT_SS` → `RasterContext.maxTextSupersampling`
  - `src/player/create-controller.ts`: sends the command first
  - the BD-J JVM's caches, if M5 introduced size constants (see Step 3)

**Interfaces:**
- Produces:
  ```ts
  type MemoryProfileName = 'desktop' | 'constrained';
  interface MemoryProfile {
    readonly igPreloadLimitBytes: number;
    readonly assEventCacheBytes: number;
    readonly assLayerCacheBytes: number;
    readonly assMaskCacheBytes: number;
    readonly maxTextSupersampling: number;
    readonly maxQueuedFrames: (codedWidth: number) => number;
  }
  const MEMORY_PROFILES: Readonly<Record<MemoryProfileName, MemoryProfile>>;
  ```
  - `desktop` values are today's constants: 512 MB; 128, 128 and 64 MB; 8; and 8 frames.
  - `constrained` uses the Global Constraints values.
  - UI side: `chooseMemoryProfile(env: { search: string; coarsePointer: boolean; maxTouchPoints: number; platform: string }): MemoryProfileName`. The `?memory=desktop|constrained` override wins. Otherwise the profile is `constrained` when `coarsePointer`, or when `maxTouchPoints > 1 && platform === 'MacIntel'` (iPadOS reports a Mac: the documented sniffing exception); else `desktop`.

- [ ] **Step 1: Write failing tests:**
  - `chooseMemoryProfile` cases: iPhone (coarse) gives constrained; iPad with trackpad (`MacIntel`, 5 touch points, fine pointer) gives constrained; Mac gives desktop; `?memory=desktop` on iPhone gives desktop.
  - In `player.test.ts` (or the existing preload test), with the profile set to `constrained`, a sub-path clip of 65 MB is rejected with `DiscError('unreadable-stream', "This disc's menus need more memory than this device allows.")`, and the same clip under `desktop` is preloaded.
  - `MEMORY_PROFILES.constrained.maxQueuedFrames(3840) === 4` and `maxQueuedFrames(1920) === 8`.
- [ ] **Step 2: Run** the new tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Thread the profile through `Player`, defaulting to `desktop` so tests and vm-trace runs are unchanged.
  - The ASS renderer reads its limits from the deps.
  - After M5: if the JVM (`src/engine/bdj/`) holds caches with byte or entry limits, add them to `MemoryProfile`. Halve them under `constrained` unless the Task 1 probe shows the iPhone is comfortable, and record the values chosen in the spec §3.5 table.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS, with vm-trace and bdj-trace unchanged.
- [ ] **Step 5: Commit** `feat(engine): constrained memory profile for phones and tablets`.

### Task 6: Fullscreen adapter

**Files:**
- Create: `src/ui/fullscreen.ts`, `src/ui/fullscreen.test.ts`
- Modify: `src/ui/PlayerScreen.tsx` (`toggleFullscreen`), `src/ui/ControlBar.tsx` (hide the button when unsupported)

**Interfaces:**
- Consumes: `CapabilityReport.fullscreen`.
- Produces: `toggleFullscreen(doc: Document, element: HTMLElement, kind: 'standard' | 'webkit'): void`.

- [ ] **Step 1: Write failing tests.** `kind: 'webkit'` calls `webkitRequestFullscreen`, or `webkitExitFullscreen` when `webkitFullscreenElement` is set. `'standard'` keeps today's calls.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `ControlBar` hides the Fullscreen button when `fullscreen === null`.
  - The `F` key does nothing then.
  - On a coarse-pointer device that isn't running standalone (`matchMedia('(display-mode: standalone)')`), show a one-time dismissible hint in the player: `Add to Home Screen to watch fullscreen.`
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): fullscreen on Safari, hidden where unsupported`.

### Task 7: iOS audio session and sample rate

**Files:**
- Modify: `src/player/audio-output.ts`; `src/player/pcm-worklet.ts` and `src/engine/audio/ring.ts` only if Step 3 applies
- Test: `src/player/audio-output.test.ts` (create; fake `AudioContext` injected through a new constructor parameter `createContext?: (opts: AudioContextOptions) => AudioContext`)

- [ ] **Step 1: Write a failing test.** `ensureStarted` sets `navigator.audioSession.type = 'playback'` before creating the context. Inject the navigator as a second constructor parameter, `nav?: { audioSession?: { type: string } }`. With no `audioSession` it doesn't throw.
- [ ] **Step 2: Implement and run.** Expected: PASS.
- [ ] **Step 3: Only if Task 1 found a sample rate other than 48000 on a supported device,** resample in `pcm-worklet.ts`. Linear interpolation from the 48 kHz ring to `sampleRate`. The frames-played counter keeps counting consumed 48 kHz source frames, so `MasterClock` is unchanged.
  - Test: a ring holding a 1 kHz sine at 48 kHz, rendered at 44100, gives a 1 kHz sine (zero-crossing count within ±1 over 4410 frames), and the counter advances by 4800.
  - If it doesn't apply, write `48 kHz honoured on all probed devices` in the known-issues probe table and skip.
- [ ] **Step 4: Commit** `feat(audio): playback audio session on iOS`.

### Task 8: Pause when the platform suspends audio

**Files:**
- Modify: `src/player/player-controller.ts` (`AudioOutputLike` gains `onStateChange(cb: (state: AudioContextState | 'interrupted') => void): void`), `src/player/audio-output.ts`, `src/player/player-controller.test.ts`

- [ ] **Step 1: Write failing tests** with a fake `AudioOutputLike` and an injected `visibility: { hidden(): boolean; onChange(cb: () => void): void }`:
  - While playing, the page goes hidden and the audio reports `'suspended'`. The controller sends `pause`. On visible it shows notice code `background-pause` with message `Playback paused while the app was in the background.`
  - While playing, the page goes hidden and the audio stays `'running'`, as on desktop Chrome. No pause and no notice (Review Focus 2).
  - Audio reports `'interrupted'` (iOS phone call) while visible. The controller pauses with the same notice.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** `AudioOutput` forwards `context.onstatechange`. The controller pauses only on a suspension it didn't request. It doesn't auto-resume.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(player): pause when the platform suspends audio`.

### Task 9: Wake Lock and Media Session

**Files:**
- Create: `src/player/platform-session.ts`, `src/player/platform-session.test.ts`
- Modify: `src/ui/App.tsx` (wire it to the controller's snapshot)

**Interfaces:**
- Produces: `class PlatformSession { constructor(nav: NavigatorLike, controller: Pick<PlayerController, 'togglePlay' | 'seekBy' | 'getSnapshot' | 'subscribe'>) ; dispose(): void }`.
  - It holds a `screen` wake lock while `engineState === 'playing'` and re-requests it on `visibilitychange` back to visible.
  - It sets `mediaSession.metadata` (title = disc title or playlist name; artist = chapter `Chapter N`).
  - Media Session handlers: `play`/`pause` call `togglePlay` when the state differs; `seekbackward`/`seekforward` seek 10 s.

- [ ] **Step 1: Write failing tests** with a fake navigator. Wake lock is requested on `playing` and released on `paused`. The `seekforward` handler calls `seekBy(10_000_000)`. Without `wakeLock`/`mediaSession` nothing throws.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4 (only if Task 1 showed worker-raf p95 above 20 ms on a supported browser):** the controller posts a `{ type: 'frameTick' }` command from the main thread's `requestAnimationFrame` while playing. `worker.ts`'s `requestFrame` waits for the next tick instead of `setTimeout(16)` when the worker has no rAF. Test in `player-controller.test.ts`: ticks are posted only while playing.
- [ ] **Step 5: Run and commit** `feat(player): wake lock and media session`.

### Task 10: Touch gestures on the video

**Files:**
- Create: `src/ui/touch.ts`, `src/ui/touch.test.ts`
- Modify: `src/ui/PlayerScreen.tsx` (canvas pointer handling uses `pointerType`; the click handler stays for mouse)

**Interfaces:**
- Produces:
  ```ts
  interface Tap { readonly x: number; readonly timeMs: number }
  type TapAction = 'toggleControls' | 'seekBack' | 'seekForward' | 'menuClick' | 'none';
  classifyTap(prev: Tap | null, tap: Tap, ctx: { width: number; menuActive: boolean }): TapAction
  ```
  Constants: `DOUBLE_TAP_MS = 300`. Zones: left third, middle, right third.

- [ ] **Step 1: Write failing tests:**
  - With `menuActive: true`, every tap is `'menuClick'` (Review Focus 3).
  - A single tap is `'toggleControls'`.
  - A second tap within 300 ms in the right third is `'seekForward'`, and in the left third `'seekBack'`.
  - A second tap in the middle is `'toggleControls'`.
  - A second tap after 300 ms is a fresh `'toggleControls'`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - For `pointerType === 'touch'`, `PlayerScreen` handles `pointerup` on the canvas with `classifyTap`.
  - A single `toggleControls` is delayed by `DOUBLE_TAP_MS` so a double tap doesn't flash the controls.
  - `menuClick` sends `controller.pointer('click', …)` as the mouse click does.
  - Seeks use `seekBy(±10_000_000)` through the same UO check as the keyboard.
  - Touch never toggles play from the video; the Play button does.
  - Touch also skips `pointer('move')` hover.
- [ ] **Step 4: Run** the tests, plus an E2E in the `mobile-chromium` project (Task 15) on `fixtures/synthetic/disc-menu`: a tap on a menu button's centre activates it (same assertion as the existing mouse test in `menus.spec.ts`), and a double tap on the right third advances `timeUs` by about 10 s.
- [ ] **Step 5: Commit** `feat(ui): touch gestures on the video and menus`.

### Task 11: Small-screen layout

**Files:**
- Modify: `index.html` (`viewport-fit=cover`), `src/ui/styles.css`, `src/ui/ControlBar.tsx`, `src/ui/AudioMenu.tsx`, `src/ui/SubtitleMenu.tsx`, `src/ui/ShaderMenu.tsx`, `src/ui/PlaylistPicker.tsx`

- [ ] **Step 1: Write a failing E2E** in `tests/e2e/mobile-layout.spec.ts`, run in `mobile-chromium` at 390×844 and 844×390:
  - With a disc playing and controls shown, `document.documentElement.scrollWidth <= innerWidth`.
  - Every visible button in `[data-testid=player] .controls` has a bounding box of at least 44×44.
  - The Audio, Subtitles and Shaders menus open fully inside the viewport.
  - The Remote toggle is visible.
- [ ] **Step 2: Run** `npx playwright test mobile-layout --project=mobile-chromium`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Media queries at `max-width: 600px` and `(pointer: coarse)`.
  - `env(safe-area-inset-*)` padding.
  - Menus become bottom sheets on narrow screens.
  - `cursor: none` only under `(hover: hover)`.
  - Controls stay visible while paused (already the case; keep it).
- [ ] **Step 4: Run.** Expected: PASS, and the existing desktop E2E tests are unchanged.
- [ ] **Step 5: Commit** `feat(ui): layout for phones and tablets`.

### Task 12: Shaders where only half-float targets render

**Files:**
- Modify: `src/engine/shaders/webgl-backend.ts`. Test: `src/engine/shaders/stage.test.ts`, or a new `webgl-support.test.ts` for the pure check.

- [ ] **Step 1: Write a failing test** for an extracted pure `floatTargetSupport(exts: (name: string) => boolean): 'float' | 'half' | null`. `EXT_color_buffer_float` gives `'float'`; only `EXT_color_buffer_half_float` gives `'half'`; neither gives `null`.
- [ ] **Step 2: Implement.**
  - The backend is UNAVAILABLE only on `null`. The UNAVAILABLE message in the Shaders menu reads `Not available on this device`.
  - Textures stay RGBA16F/RG16F/R16F. Verify nothing allocates a 32-bit float target; `grep -n "32F" src/engine/shaders` must be empty.
- [ ] **Step 3: Run** the shader unit tests and `npx playwright test shaders.spec`. Expected: PASS.
- [ ] **Step 4: Commit** `feat(shaders): run on half-float render targets`.

### Task 13: ASS without `ctx.filter` or `letterSpacing`

**Files:**
- Modify: `src/engine/ass/raster.ts` (`RasterContext` gains `readonly canvasFilter: boolean`), `src/engine/ass/renderer.ts`, `src/engine/worker.ts` (detects it once), `src/engine/ass/measure.ts`, and the raster tests

- [ ] **Step 1: Write a failing test.** With `canvasFilter: false`, a run that takes the direct path today (opaque fill, `\blur2`) is rendered through `layersFromMasks` (spy on the masks LRU `set`). With `canvasFilter: true` the direct path is unchanged.
- [ ] **Step 2: Implement.** At the `if (direct && …) return directLayers();` branch, require `rc.canvasFilter || sigma < 0.03`. Detection in `worker.ts`: draw a 1 px white dot with `filter = 'blur(2px)'` on a 9×9 OffscreenCanvas, and check that a neighbour pixel is non-zero.
- [ ] **Step 3: Only if Task 1 found `letter-spacing` missing:** `measure.ts` skips setting `letterSpacing` when unsupported (it sets `'0px'`, which is the default anyway). Check `raster.ts`'s use: if spacing is applied through `letterSpacing` when drawing, apply `\fsp` by positioning glyphs per advance instead. Test: a run with `\fsp5` draws glyph 2 at advance(1) + 5 px.
- [ ] **Step 4: Run** `npm test` and `npm run test:ass`. Expected: PASS; the Chromium goldens are unchanged.
- [ ] **Step 5: Commit** `feat(ass): blur without canvas filters`.

### Task 14: Installable offline app

**Files:**
- Create: `src/sw.ts`, `public/manifest.webmanifest`, `public/icons/` (192, 512, maskable 512, `apple-touch-icon.png` 180, made from `public/favicon.svg`), `src/ui/update-prompt.ts`, `src/ui/update-prompt.test.ts`, `tests/e2e/offline.spec.ts`
- Modify: `vite.config.ts` (`vite-plugin-pwa`, `strategies: 'injectManifest'`, `srcDir: 'src'`, `filename: 'sw.ts'`, `injectRegister: false`; precache globs include `**/*.{js,css,html,wasm,ttf,svg,png,webmanifest}`), `index.html` (manifest link, `apple-touch-icon`, `theme-color`), `src/main.tsx` (register), `package.json` (dev dependency)

**Interfaces:**
- Produces: `shouldPromptUpdate(state: { waiting: boolean; engineState: PlaybackState }): boolean`. It is true when a new worker is waiting and the engine isn't `playing` or `buffering`.

- [ ] **Step 1: Write failing tests:**
  - Unit: `shouldPromptUpdate({ waiting: true, engineState: 'playing' })` is false; with `'paused'` it is true (Review Focus 4).
  - E2E `offline.spec.ts` (chromium and firefox projects): load `/`, wait for `navigator.serviceWorker.ready`, `context.setOffline(true)`, reload. Then `crossOriginIsolated === true`, `fixtures/synthetic/disc1` opens through `folder-input`, and playlist 00000 reaches `data-state="playing"`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement `src/sw.ts`.**
  - Workbox `precacheAndRoute(self.__WB_MANIFEST)`.
  - Navigation requests are network-first with a cache fallback to `index.html`.
  - Every response the worker returns, cached or fetched, is re-wrapped with `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Resource-Policy: same-origin` (a `Response` copy with the extra headers).
  - `skipWaiting` only on a `{ type: 'skip-waiting' }` message.

  UI side:
  - The update prompt `A new version is ready. Reload` appears when `shouldPromptUpdate` allows it.
  - `navigator.storage.persist()` is called once when `display-mode: standalone` matches.
  - The landing screen's help text gains: `On Safari, add the app to your Home Screen or Dock so your settings aren't cleared after 7 days without a visit.`
- [ ] **Step 4: Run** the unit tests, `npm run build` and `npx playwright test offline`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: installable offline app`.

### Task 15: Playwright projects and CI

**Files:**
- Modify: `playwright.config.ts`, `.github/workflows/ci.yml`, and the E2E specs that can't run outside Chrome (add skips)

- [ ] **Step 1: Configure.** Add `projects`:
  - `chromium`: today's `use`, `channel: 'chrome'`, autoplay flag.
  - `firefox`: `devices['Desktop Firefox']`, with `firefoxUserPrefs: { 'media.autoplay.default': 0 }`.
  - `webkit`: `devices['Desktop Safari']`.
  - `mobile-chromium`: `devices['Pixel 7']` with `channel: 'chrome'`, `hasTouch: true`.

  The A/V sync tests (`playback.spec.ts` sync cases, `audio.spec.ts`), `shaders.spec.ts`, `ass-subtitles.spec.ts` and `local-discs.spec.ts` run only in `chromium`, via `test.skip(browserName !== 'chromium' || isMobile, '<reason>')`. In `webkit`, every test that needs H.264 decode skips with `test.skip(!(await page.evaluate(() => VideoDecoder.isConfigSupported({ codec: 'avc1.640028' }).then((s) => s.supported).catch(() => false))), 'no H.264 WebCodecs in this WebKit build')`. Put the helper in `tests/e2e/support.ts`.
- [ ] **Step 2: Run** `npx playwright install firefox webkit`, then `npm run test:e2e`.

  Expected:
  - `chromium`: as before.
  - `firefox`: playback, menus, subtitles, errors and offline pass.
  - `webkit`: smoke, errors (landing-level), mobile layout and capability messages pass; the rest skip with the stated reason.

  Fix any Firefox failure in the product code, not by skipping, unless it's in the Chrome-only list above.
- [ ] **Step 3: Update CI.** `ci.yml` installs `chrome firefox webkit` with `--with-deps`. The e2e job runs all projects; the job name becomes `Browser tests`.
- [ ] **Step 4: Commit** `test(e2e): firefox, webkit and mobile projects`.

### Task 16: Documentation

**Files:**
- Modify: `CLAUDE.md` (supported browsers, the probe page, Playwright projects, memory profile, service worker), `README.md` (no "for Chromium"), `docs/known-issues.md`:
  - iPhone has no element fullscreen; use the installed app (WebKit bug 206854)
  - no background audio on iOS
  - Firefox Android unsupported
  - Android HEVC and USB OTG unverified
  - the iPadOS `MacIntel` detection exception
  - the IG constrained limit
  - the canvas-to-`<video>` fullscreen/PiP experiment, left open

- [ ] **Step 1: Write the changes.** `fs-access.d.ts` comments say "Chromium only" where they apply.
- [ ] **Step 2: Commit** `docs: cross-browser support`.

### Task 17: Real-device gate (user, manual)

- [ ] **Step 1: Deploy a preview** of the branch with `gh workflow run preview.yml --ref <this branch>` (Task 1 Step 0).
- [ ] **Step 2: Run the spec §3.7 gate** on iPhone (iOS 26), iPad (iPadOS 26, USB drive in Files), Safari macOS and Firefox desktop.

  Per device:
  - Open a 1080p H.264 disc, a 1080i disc, an HEVC disc and a BD-J disc.
  - Navigate an HDMV menu and a BD-J menu by touch.
  - PGS and ASS subtitles; switch audio; seek.
  - Play ten minutes with `?telemetry=1` and no visible drift.
  - Install, go offline, and open a disc.

  On the Android emulator, do the subset in spec §3.7.
- [ ] **Step 3: Record the results** in the spec's Status line (date, devices, pass/fail per item), as earlier milestones did. Turn any failure into a fix task before merging, or into a known issue if the user accepts it.
- [ ] **Step 4: Commit** `docs: step 1 device gate results`.
