# Milestone 3: HDMV Menus — Design Spec

Date: 2026-10-14
Status: Approved design, pending spec review
Parent spec: `2026-10-12-bluray-web-player-design.md` (§5, §7, §8, §9, §11 milestone 3)

## 1. Goal and scope

A user opens a decrypted HDMV disc and it boots the way a player does: First Play, then the Top Menu with visible, selectable buttons. They can navigate menus by keyboard, mouse or an on-screen remote, use the feature's pop-up menu, hear menu sounds when the disc has them, and see why a disabled control is unavailable. BD-J discs keep the playlist-picker fallback.

In scope:

- `MovieObject.bdmv` parsing and the HDMV navigation VM (all instruction groups), with the register file (4096 GPRs, 128 PSRs).
- Interactive graphics (IG): segment decoding, RLE and palette decoding, the graphics controller (pages, button-overlap groups, neighbour navigation, button states and animations, auto-action, timeouts, enable/disable, always-on and pop-up menus).
- Navigation glue: First Play, Top Menu, titles, VM-driven playback, end-of-playlist resume, stills, and user-operation (UO) masks with UI feedback and enforcement.
- Input: keyboard, mouse hover and click, an on-screen remote pad, the Top Menu and Pop-up keys.
- Menu sound effects from `AUXDATA/sound.bdmv`.
- A libbluray trace harness that runs real libbluray on a disc with scripted input and compares its trace with ours.

Out of scope: BD-J (unchanged: picker fallback), PG subtitles (M4; they share the graphics decoders, which are written for reuse), multi-angle, PiP, text subtitles, and libbluray's BD-J "known playlist" properties.

Decisions taken during brainstorming:

| Question | Decision |
|---|---|
| Approach | Port libbluray's menu stack to TypeScript in the engine worker, drawn on the existing canvas (not DOM buttons; not libbluray compiled to WASM) |
| VM verification | Native libbluray harness, built from source with a register-write log patch, plus unit tests |
| Input | Keyboard, mouse hover and click, on-screen remote pad, menu sound effects |
| Structure | One milestone and one spec; the implementation plan is phased (VM and navigation → graphics → input and UI) |

## 2. Components

All engine code is ported from libbluray at commit `448f896` (the commit already used for the parsers), lives under `src/engine/`, is LGPL-2.1-or-later with SPDX headers, and is listed in `src/engine/NOTICE`.

| File | Ported from | Responsibility |
|---|---|---|
| `bdmv/mobj-parser.ts` | `hdmv/mobj_parse.c` | Movie objects: 12-byte navigation commands, resume intention, menu-call and title-search masks |
| `bdmv/sound-parser.ts` | `bdnav/sound_parse.c` | `sound.bdmv` clips (LPCM) |
| `hdmv/registers.ts` | `register.c` | `RegisterFile`: GPRs and PSRs with libbluray's initial values, change listeners, save/restore for CALL/RESUME, an optional write-log hook for traces |
| `hdmv/vm.ts` | `hdmv/hdmv_vm.c`, `hdmv_insn.h` | `HdmvVm`: instruction decode and execution in step-budgeted batches; `selectObject`, `setObject`, `run`, `suspendPlaylist`, `resume`, `uoMask`; events `TITLE`, `PLAY_PL`, `PLAY_PL_PI`, `PLAY_PL_PM`, `PLAY_PI`, `PLAY_PM`, `PLAY_STOP`, `STILL`, `SET_BUTTON_PAGE`, `ENABLE_BUTTON`, `DISABLE_BUTTON`, `POPUP_OFF`, `END`, `IG_END` |
| `graphics/ig-decoder.ts` | `decoders/ig_decode.c` | ICS, PDS, ODS and END segments into display sets: pages, BOGs, buttons, neighbour links, states, commands, timeouts |
| `graphics/rle.ts`, `graphics/palette.ts` | `decoders/rle.c`, `graphics_processor.c` | RLE objects to RGBA via YCbCr BT.709 palettes |
| `graphics/graphics-controller.ts` | `decoders/graphics_controller.c` | `GraphicsController` mirroring `gc_run`: input `INIT_MENU`, `NOP`, `RESET`, `VK_KEY`, `MOUSE_MOVE`, `ENABLE_BUTTON`, `DISABLE_BUTTON`, `SET_BUTTON_PAGE`, `POPUP`, `IG_END`; output overlay operations (draw object, wipe, clear, flush), button commands to run, sound IDs, status (menu open, pop-up loaded, animating) |
| `nav/navigator.ts` | parts of `bluray.c` | `Navigator`: owns VM, registers and graphics controller; plays First Play, Top Menu and titles from `index.bdmv`; maps VM events to player actions; resumes the VM at playlist end; combines and enforces UO masks |

Changes to existing code:

- `Player` delegates what to play to the `Navigator` and keeps decode, A/V sync and presentation.
- `PlaybackPipeline` demuxes the selected IG PID as a third sink, with PTS.
- `Compositor` gains an IG plane above the video.
- Protocol: events `menuActive`, `uoMask`, `soundEffects` (clips, once per disc), `soundEffect { id }`, `indexTitles` (the `index.bdmv` titles; the existing `titles` event keeps carrying the playlist list); commands `menuKey` (up, down, left, right, ok, 0–9, topMenu, popup), `pointer { kind: move | click, x, y }` in 1920×1080 menu space, `playTitle { title }`.
- `Telemetry` gains `menu: { page, selectedButton, buttonsDrawn } | null` and `igErrors`.

Test tool: `tools/vm-trace/` (C source and Docker build; not shipped).

## 3. Runtime data flow

### 3.1 Boot

After `open`, if First Play in `index.bdmv` is an HDMV object, the `Navigator` starts the VM on it, so the disc boots without the picker. Top Menu and titles come from the same index. If First Play is BD-J or missing, the playlist picker appears as today. A Titles button keeps the picker reachable on HDMV discs.

### 3.2 VM-driven playback

`Navigator.tick()` runs once per render frame and calls `vm.run()` until the VM stops for an event:

| VM event | Action |
|---|---|
| `PLAY_PL`, `PLAY_PL_PI`, `PLAY_PL_PM` | `player.playPlaylist(id, { item } or { mark })` |
| `PLAY_PI`, `PLAY_PM` | seek within the current playlist |
| `PLAY_STOP` | stop playback |
| `STILL` | hold the current frame |
| `TITLE` | run that title's movie object |
| `SET_BUTTON_PAGE`, `ENABLE_BUTTON`, `DISABLE_BUTTON`, `POPUP_OFF`, `IG_END` | pass to the graphics controller |

At the end of a playlist, including play-item still handling (infinite, or N seconds then continue), the `Navigator` resumes the suspended program, as libbluray does at end of playlist. Commands run in batches with a step budget (libbluray's value).

### 3.3 IG timing

Our reader runs up to 2 s ahead of playback, unlike libbluray's paced `bd_read`. IG PES units are therefore queued by playlist PTS, and each tick passes the graphics controller only units whose PTS the master clock has reached. On a seek, the queue and the controller's IG state are reset and decoding resumes at the next epoch start or acquisition point.

### 3.4 Graphics output

Each tick also sends `NOP` (timers and animations). Overlay operations update one 1920×1080 `OffscreenCanvas` (the IG plane). Decoded objects are cached as `ImageBitmap`s keyed by object ID and version. The compositor draws the plane over the video with the same letterboxing, redrawing only when the controller reports a change.

### 3.5 Button activation

The controller returns the activated button's commands, the `Navigator` hands them to the VM (`setObject`), and the next `run` produces events as for any program.

### 3.6 UO masks

The `Navigator` combines the playlist, play item and menu (ICS) masks with the movie object's menu-call and title-search flags. It emits `uoMask` when the result changes, and refuses masked commands with a `notice` ("The disc doesn't allow this here").

### 3.7 Sound effects

At disc open the engine sends the parsed `sound.bdmv` clips once (`soundEffects`). During playback it emits `soundEffect { id }`. The main thread plays clips through the existing `AudioContext` and gain node, independent of the video's audio ring, so they also play during still menus.

## 4. Input and UI

### 4.1 Keyboard

| Key | Menu page active | Otherwise |
|---|---|---|
| Arrows | `menuKey` up/down/left/right | seek ±10 s, volume (unchanged) |
| Enter | `menuKey ok` | — |
| 0–9 | `menuKey` digit | — |
| `M` | Top Menu | Top Menu |
| `P` | Pop-up on/off | Pop-up on/off |
| Space, `A`, `F` | unchanged | unchanged |

The open audio menu keeps priority for its own keys.

### 4.2 Pointer

Canvas pointer events are mapped to 1920×1080 menu space with the compositor's letterbox geometry (one shared, unit-tested helper). Moves are throttled to one per animation frame (`pointer move`: hover selects); clicks send `pointer click` (activate). The engine reports the button under the pointer so the cursor can show a pointer there.

### 4.3 Control bar and picker

- New buttons: Top Menu, Pop-up (shown only when the current playlist has a pop-up menu), Titles.
- Controls disabled by the UO mask are greyed out with the tooltip "The disc doesn't allow this here".
- The picker lists index titles ("Title 1…N", which call `playTitle`) above the raw playlists (which play directly, as today).

### 4.4 On-screen remote pad

`src/ui/RemotePad.tsx`: a toggleable overlay with arrows, OK, 0–9, Top Menu and Pop-up sending `menuKey`. It auto-hides with the controls and is keyboard- and screen-reader-accessible.

### 4.5 Controller state

`PlayerSnapshot` gains `menuActive`, `popupAvailable`, `uoMask` and `indexTitles`, fed by `reduceEvent`.

## 5. libbluray trace harness

### 5.1 Build

`tools/vm-trace/build.sh` runs in Docker (pinned image digest, `linux/amd64`). It clones libbluray at `448f896`, applies `trace.patch` (about 20 lines in `register.c` that log every GPR and PSR write as `{ reg, index, value }`), builds libbluray statically without BD-J, fonts or XML, and compiles `vm_trace.c`.

### 5.2 Run

`vm_trace <disc> <script>` plays from First Play through `bd_play` and `bd_read_ext` as fast as it can read (no decoding; libbluray still demuxes IG, so menus load). Scripts are event-driven steps: `wait menu`, `wait playlist NNNNN`, `wait time Ns`, `key up|down|left|right|ok|0-9|topmenu|popup`, `mouse X Y [click]`. Output is JSON lines tagged with media time: register writes; playlist, play item, chapter and title starts; menu and pop-up on/off; UO mask; sound effects; PSR10/11 (selected button and page).

### 5.3 Our side

`tests/vm-trace/replay.ts` runs the same script through the real `Navigator`, VM and graphics controller, real disc parsing and IG demux, with a simulated clock instead of video decoding, and writes the same format.

### 5.4 Comparison

Traces are compared in order. Register writes and navigation events must be identical; media times must agree within one frame. The first divergence is printed with context (for example "GPR 12: libbluray 3, ours 2, after key ok at 00001 12.4 s").

### 5.5 Where it runs

- Synthetic discs `fixtures/synthetic/disc-vm` (hand-built movie objects: arithmetic, compare, jumps, CALL/RESUME, play at item and mark, stills) and `fixtures/synthetic/disc-menu` (a two-page IG menu with neighbour navigation, a button that plays a playlist, and a pop-up). Their libbluray traces are committed as golden files under `tests/vm-trace/golden/`.
- CI replays our side against the golden traces on every run (no Docker needed).
- A path-filtered workflow (`.github/workflows/vm-trace.yml`, triggered by `tools/vm-trace/**` and the two synthetic discs) rebuilds the harness, regenerates the golden traces and fails if they differ.
- Real discs: `npm run vm-trace -- <disc> <script>` runs both sides live and compares (local only). `tests/vm-trace/scripts/tsurune.keys` covers TSURUNE.

## 6. Errors

| Situation | Behavior |
|---|---|
| VM step budget exceeded or invalid instruction | Stop the title, log the VM trace to the console, show the picker with a notice |
| VM jumps to a BD-J title | Notice "This title needs BD-J", then the picker |
| `MovieObject.bdmv` missing or damaged | Playlist picker as today, plus a warning |
| Corrupt IG segment or display set | Dropped; counted in `igErrors`; the menu keeps its last good state |
| Masked control used | Refused with a notice |
| `sound.bdmv` missing or damaged | No menu sounds, silently |

## 7. Testing

- Unit tests (Node) for each ported module with hand-built inputs: movie-object parser; registers (initial PSRs, save and restore); VM by instruction group (branch, compare, set, CALL/RESUME, play variants); IG segment decoding; RLE and palette; graphics controller (neighbour navigation, auto-action, enable/disable, page changes, timeouts, animations, pop-up); `Navigator` (First Play, end-of-playlist resume, stills, UO mask combination and enforcement); pointer mapping; keyboard routing.
- New builders in `tests/helpers/`: movie objects, IG segments, `sound.bdmv`.
- Trace replay against the golden libbluray traces (CI).
- Chrome E2E (`tests/e2e/menus.spec.ts`, `disc-menu`): boots into the menu with buttons drawn (telemetry `menu`); arrows and Enter, mouse hover and click, and the remote pad each select and activate a button that starts a playlist in sync; the pop-up toggles during playback; a masked control is disabled and its shortcut refused; a menu sound event fires.

## 8. Exit criteria

1. CI is green, including trace replay; the harness-regeneration workflow passes.
2. TSURUNE_TSUNAGARI_1 in Chrome: boots through First Play to its top menu with buttons drawn; keyboard, mouse and remote can each start the feature from the menu; the feature's pop-up menu opens and closes; masked controls are disabled; `npm run vm-trace` matches libbluray for the scripted sessions menu → feature and pop-up open → close.
3. The BD-J discs (A_NEW_ERA, RENTAL_FAMILY) still open to the picker with the correct main feature.
4. Menu sounds are verified on synthetic data only and recorded as such in `docs/known-issues.md` until a disc with `sound.bdmv` is available.
