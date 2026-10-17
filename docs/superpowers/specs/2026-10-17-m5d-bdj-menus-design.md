# Milestone 5d: BD-J Menus on Every Device — Design Spec

Date: 2026-10-17
Status: Draft, awaiting review.
Builds on: `2026-10-16-m5c-bdj-playback-design.md` (BD-J titles drive playback; §9 deviations), `2026-10-15-m5b-bdj-jvm-core-design.md`, and the cross-browser spec `2026-10-16-cross-browser-and-remote-design.md` §3.9 (BD-J on phones, handed to milestone 5). Parent: `2026-10-12-bluray-web-player-design.md`.

## 1. Intent

After 5c, a BD-J disc's Java code runs and drives playback, but its menu is invisible and can't be used. After 5d, the user opens a BD-J disc on a computer or on a phone or tablet and gets **a faithful representation of the menu, as if using a Blu-ray player** (the user's words): the disc's own menu graphics drawn over the video, driven with a remote, keyboard, mouse or touch, through to the feature.

Devices the user will check on (the user's): iPhone 17 Pro, iPad Pro 12.9-inch (5th generation), MacBook Pro 16-inch (M5 Max) with Safari and Firefox, plus desktop Chrome as today.

### Goals

1. BD-J menus are drawn over the video, matching what libbluray draws for the same disc, pixel for pixel at checked points.
2. The menus work with a remote's keys (keyboard arrows/Enter/Escape and the existing on-screen remote), Top Menu and the pop-up menu key, as libbluray sends them to Java.
3. On touch and mouse, a tap or click on the menu reaches the disc as libbluray's mouse input. When the disc isn't listening for mouse input at that moment, the on-screen remote opens by itself and a notice says the disc didn't take the tap (the user's choice).
4. Text in BD-J menus renders as libbluray renders it (FreeType), with the disc's own fonts.
5. Both local discs can be driven from their first menu to the feature (A_NEW_ERA: PLAY; RENTAL_FAMILY: language picker, then main menu, then PLAY).
6. All of this works on iPhone, iPad, Safari macOS and Firefox desktop, not only Chrome (handed over by the cross-browser spec §3.9).
7. Start-up on iPhone: open A_NEW_ERA → first logo frame within **10 s** (target), and **over 15 s is a blocker** (the user: "maybe 10–15 seconds"; this split is my reading). Desktop Chrome keeps 5c's 5 s bar.
8. The JVM stays within the constrained memory profile on iPhone and iPad (cross-browser spec §3.5), measured on the real devices.

### Non-goals (5e or later)

- Saving disc data between sessions (BD-J persistent storage), BD-Live/network, BUDA/virtual packages.
- Broader speed work beyond what the phone targets need (a JIT stays the lever in reserve, as in 5c).
- Secondary video (picture-in-picture), 3D, angle switching.

### Anti-goals (failure even if it works)

- A menu that looks right but can't be operated on a phone (no way from the menu to the feature by touch).
- A tap that silently does nothing (the user said: open the remote and say so).
- iPhone start-up over 15 s, or the page killed for memory on iPhone/iPad during menu use, treated as a known issue instead of a blocker (cross-browser spec §3.9).
- Regressions: HDMV menus, subtitles, shaders, A/V sync, the 5c control-call parity and the desktop 5 s bar all keep passing unchanged.

## 2. Constraints

- Port function by function from libbluray at `448f896`; record sources in `src/engine/NOTICE`; `src/engine/` stays LGPL and free of UI imports; GPLv2+CPE code stays in `src/bdj-classlib/`.
- Cross-origin isolation stays (SharedArrayBuffer is already required).
- Supported browsers as in the cross-browser spec: Safari 26 (macOS, iOS, iPadOS), Chrome and Firefox desktop (stable and stable−2), Chrome Android. No user-agent sniffing beyond the existing iPadOS check.
- New browser APIs behind injectable deps (the `PlayerDeps` pattern), so the player stays testable in Node.
- Build artifacts (WASM, class library, goldens) change only through their scripts, with CI diff checks.

## 3. Decisions taken in the conversation

| Question | Decision (whose) |
|---|---|
| What 5d delivers | Faithful BD-J menus, as on a Blu-ray player, on computers and phones/tablets (user) |
| Touch | Both tapping the menu directly and an on-screen remote (user) |
| Disc ignores taps | Open the on-screen remote by itself, with a notice that the disc didn't take the tap (user) |
| iPhone start-up | 10–15 s from open to first logo frame (user); 10 s target, > 15 s blocker (my reading) |
| Test devices | iPhone 17 Pro, iPad Pro 12.9" 5th gen, MacBook Pro M5 Max (Safari, Firefox), desktop Chrome (user) |
| iOS Simulator | Used for repeated functional checks during the work; real devices for timing and memory (user agreed; the user installs Xcode) |
| How "faithful" is checked | Pixel comparison against libbluray's own frames at checked points, plus driving both discs to the feature (my proposal, not objected to) |
| Getting the discs onto the iPhone/iPad | Both routes: a development disc server on the Mac over the home network (most runs, hands-off), and a USB-C SSD picked in Files (the real-world route; the user picks the folder once per session) (user) |
| Who runs device checks | The builder drives the plugged-in iPhone and iPad (Xcode + Appium/XCUITest for Safari, Safari's remote inspector for logs and telemetry); the user does the one-time setup (Developer Mode, trust, a free Apple ID signing of the automation helper, re-signed every 7 days) and folder picks on the USB route (user agreed) |
| Menu responsiveness | Key press or tap → visible menu change within 0.2 s on a computer and 0.5 s on the iPhone (my proposal, user agreed) |

## 4. Design

### 4.1 Graphics: the BD-J plane

- libbluray's Java stack draws into its own `int[]` back buffer and calls `updateGraphicN(width, height, argb, x0, y0, x1, y1)` with a dirty rectangle (`bdj/native/org_videolan_Libbluray.c` `_updateGraphic`), which libbluray turns into ARGB overlay operations (init, draw dirty rect, flush, close). Port `_updateGraphic` and the overlay semantics.
- The BD-J worker copies the dirty rectangle into a **shared ARGB plane** (a `SharedArrayBuffer`, 1920×1080×4 bytes, plus a small header for size, dirty bounds and a flush counter) and signals the engine worker; nothing is copied per frame beyond the dirty rectangle. (My call.)
- The compositor draws the BD-J plane where the IG plane goes today (over video and subtitles), scaled to the video rectangle like IG. It draws only on a flush, at the next presented frame, so half-drawn updates never show.
- The plane is cleared and hidden when BD-J stops, a playlist is picked from the picker, or the disc closes.
- **Background plane (my call, from the user's "as if using a Blu-ray player").** libbluray leaves `HStillImageBackgroundConfiguration.displayImage` unimplemented, so it never draws a disc's background still; a real player does, and both local discs use `HBackgroundImage`. 5d draws background stills under the video as a player does. Their pixels are never Java-visible, so the browser decodes them (`createImageBitmap`); comparisons with libbluray cover the graphics plane only, and the background is checked visually. If a disc decodes JPEGs that Java then reads (AWT images drawn into the graphics plane), Java-visible decoding must match the JRE's libjpeg: the builder checks whether the local discs need it and, if so, builds libjpeg into WASM through the same pipeline as FreeType.
- **Title changes.** BD-J→BD-J title changes (including Top Menu from a BD-J feature) already stay inside one JVM; only HDMV↔BD-J handoffs start a new one (5c deviation 5), which 5d keeps.

### 4.2 Input

- **Keys.** Keyboard arrows, Enter, Escape/Back, number keys, colour keys where mapped today, Top Menu and the pop-up key go to Java as `BDJ_EVENT_VK_KEY` exactly as `bd_user_input` sends them (pressed/typed/released flags, `_get_key_uo_index` UO checks). libbluray does not filter these by key interest: the BDJO table and `setKeyInterestN` only cover transport keys (play, stop, skip, pause…), which libbluray cannot send to Java at all, and it only reports the table to the host. So 5d sends navigation keys unfiltered and leaves the player's own transport controls as they are. (My call, following libbluray.) The existing on-screen remote (`RemotePad.tsx`) sends the same keys.
- **Mouse and touch.** A click or tap maps to 1920×1080 menu space (`pointer.ts`, as HDMV) and goes to Java as libbluray does: `bd_mouse_select` → `BDJ_EVENT_MOUSE` (position) and the activate key (`BD_VK_MOUSE_ACTIVATE` through `bd_user_input`). Mouse movement on desktop sends `BDJ_EVENT_MOUSE` as the pointer moves over the video while a BD-J title runs.
- **When a tap is a menu tap (my call).** BD-J has no "menu shown" signal, and A_NEW_ERA plays its feature inside a BD-J title. So: while the BD-J plane shows any visible (non-transparent) pixels, a tap on the video goes to the disc; while the plane is empty (feature playing, nothing drawn), a tap shows or hides the player controls as today (`src/ui/touch.ts`). Desktop mouse clicks follow the same rule.
- **Disc ignores taps (the user's rule; detection is my call).** "Didn't take the tap" means nothing happened, not merely "no listener": libbluray posts every mouse event to the focus owner without hit-testing (`BDJHelper.postMouseEventImpl`), and a registered listener can still ignore a tap on empty space. So the engine forwards the tap and watches for a reaction within the responsiveness window (§1, 0.2 s computer / 0.5 s iPhone): a plane flush, a control call (selectPlaylist, seek, title change…) or a register write. If none comes, the on-screen remote opens by itself and a notice says "This disc's menu doesn't respond to taps here. Use the remote." Not repeated on every tap: once per menu (until the plane is next cleared).
- **Responsiveness (user).** Key press or tap → visible menu change within 0.2 s on a computer and 0.5 s on the iPhone, measured from input to the next presented frame containing the plane change.

### 4.3 Fonts and text

- libbluray renders BD-J text with FreeType (`java_awt_BDFontMetrics.c`, `java_awt_BDGraphics.c` `drawStringN`). 5b stubbed these natives. Port them over **FreeType compiled to WebAssembly**, built with the existing pinned emsdk Docker pipeline (like `audio.wasm`, CI rebuild-and-diff), so glyph rasterisation matches libbluray's. (My call; canvas text could not match pixel for pixel.)
- Fonts come from where libbluray takes them: the disc's font index (`BDMV/AUXDATA/dvb.fontindex` and `*.otf`, `org/videolan/FontIndex*.java`) and the BDJO default font. When a disc asks for a system font name libbluray would resolve through the JRE's font directory or fontconfig, both our player and the libbluray trace harness resolve it to the same bundled open-licence font (the one ASS already ships, `default-font.ttf`, unless the comparison shows a reason to add another), so pixel comparisons stay meaningful.

### 4.4 Faithfulness checks

- Extend the libbluray BD-J harness (`tools/bdj-trace/`) to dump the ARGB plane at each flush (hash plus PNG on request), and to replay a key script (`.keys`, like vm-trace) so both sides receive the same keys at the same points.
- Our replay (`tests/bdj/replay-player.ts`) dumps the same plane hashes at each flush. Comparison: plane hashes at the checked points of each script match; where FreeType hinting or timing makes a frame legitimately differ, the difference is recorded and explained, not hidden.
- Scripts: A_NEW_ERA from first menu to PLAY and to CHAPTERS; RENTAL_FAMILY language picker → main menu → PLAY. The synthetic BD-J disc gains a small menu xlet (text, an image, focus moves on arrows, mouse handling) with a committed golden, so CI checks the plane path.

### 4.5 Every device

- **Browsers.** The BD-J worker and its dependencies (SharedArrayBuffer, Atomics, nested worker creation from the engine worker, OffscreenCanvas where used, the FreeType WASM) are checked against the capability report (`src/ui/capabilities.ts`) on Safari and Firefox; a missing capability gives a named message and the picker, never a silent failure. Where Safari or Firefox lacks something the design needs (for example nested workers), the builder brings an alternative back rather than dropping a browser.
- **Memory.** The constrained profile (`src/engine/memory-profile.ts`) gains BD-J budgets: JVM caches (inflated class bytes, resolved constant pools where they can be dropped, intrinsic tables), the VFS's in-memory disc cache (`/tmp` copies of disc JARs), and the plane buffer. Budgets are measured on the iPhone and iPad with A_NEW_ERA and RENTAL_FAMILY menus in use for ten minutes; the page must not be killed.
- **Start-up on iPhone.** Measured with the 5c telemetry (`bdj.firstFrameMs`) on the real iPhone. Over 10 s means more speed work in 5d; over 15 s is a blocker for the milestone (cross-browser spec §3.9). The JIT remains the lever in reserve; using it is a decision brought back to the user.
- **Getting discs onto devices (user: both routes).**
  - *Development disc server:* a small server on the Mac serves disc folders over the home network with HTTP byte ranges, and the player opens a disc by URL through a `ByteSource` that reads ranges over HTTP. It is development tooling, but built as the seed of the cross-browser spec's step 2 (NAS server, §4 there: same range-serving shape, a remote `ByteSource` in the engine), not throwaway. Access is limited to the local network and a per-run token; nothing is exposed beyond the home network.
  - *USB-C SSD:* the disc folder picked in Files on iPhone/iPad. First tasks of the plan: the open device checks over USB (Blob slicing beyond 4 GiB, HEVC decode on iPhone and iPad), so a failure is known early.
  - Start-up is recorded for both routes.
- **Who drives the devices.** The builder drives the plugged-in iPhone and iPad (Xcode, Appium with the XCUITest driver for Safari, Safari's remote inspector for logs and telemetry) and the iOS Simulator for repeated checks during development. The user does the one-time setup (installing Xcode, Developer Mode, trusting the Mac, signing the automation helper with a free Apple ID every 7 days) and picks the folder on the USB route.
- **Real-device gate** at the end: both discs on iPhone, iPad, Safari macOS, Firefox desktop and Chrome — menu to feature by touch and keys, start-up times and menu responsiveness recorded, ten minutes in menus without a memory kill.
- **Browsers without HEVC (my call).** A_NEW_ERA's video is HEVC. On a browser without WebCodecs HEVC (likely Firefox), A_NEW_ERA shows today's HEVC message and that browser's gate runs on RENTAL_FAMILY (H.264); keeping BD-J running over missing video is not attempted.
- **The desktop 5 s bar (my call).** 5d adds real font rendering and plane work to the start-up path; the 5 s warm bar for A_NEW_ERA in desktop Chrome still applies. If 5d pushes it over, speed work to recover it is part of 5d; a JIT still needs the user's go-ahead.

## 5. Errors

- A plane, font or input failure inside BD-J is logged and does not stop playback; a JVM failure falls back to the picker with 5c's notice.
- A font the disc names but doesn't ship and that has no mapping uses the bundled fallback (as libbluray falls back), logged once per font.

## 6. Testing

- Unit: the `_updateGraphic` port and plane header; key mapping and key-interest filtering per `bd_user_input`; mouse mapping; the listening check; FreeType natives against libbluray's metrics for the bundled font.
- Golden: synthetic menu disc plane hashes from the harness, in CI.
- Local discs (`LOCAL_DISCS=1`): plane hashes at checked points and menu-to-feature scripts on both discs.
- Browser E2E: Chrome, Firefox and WebKit projects run the synthetic menu disc (draw, keys, tap, remote-on-ignored-tap); the mobile emulation project runs the touch path.
- Real-device gate as in §4.5, recorded in this spec's status line.

## 7. Exit criteria

1. Both local discs: menus drawn matching libbluray at the checked points, and driven from first menu to the feature by keys and by touch (on-screen remote where the disc ignores taps).
2. Synthetic menu disc golden matches in CI; all existing tests pass.
3. Real-device gate passed on iPhone 17 Pro, iPad Pro, Safari macOS, Firefox and Chrome, over both the development server and USB routes; iPhone A_NEW_ERA first logo frame ≤ 10 s (recorded), never > 15 s; menu responsiveness ≤ 0.2 s (computer) / ≤ 0.5 s (iPhone); no memory kill in ten minutes of menu use; desktop Chrome A_NEW_ERA still ≤ 5 s warm.
4. Docs updated (CLAUDE.md, known-issues, this spec's status and deviations).

## 8. Left to the builder

- The plane's exact header layout and signalling between workers.
- How the JVM reports mouse listening (§4.2), as long as it is cheap and invisible to Java.
- The memory budgets' numbers (measured).
- Which further speed work the iPhone needs, if any, short of a JIT (a JIT is brought back to the user).
