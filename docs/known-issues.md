# Known issues and open items

Items left open on purpose. Each one says why it was left and
what would change that decision.

## Performance

- **Rejected: demux PID peek.** Skipping unwanted PIDs before parsing measured
  103 ms vs 105 ms per 400 MB, which is no gain, so it was not kept.

## Video

- **Interlaced H.264 (1080i) is decoded in software and shown without deinterlacing.** Chrome's hardware decoders
  fail on streams with `frame_mbs_only_flag` 0 ("Decoding error"; TSURUNE's 1080i logo is MBAFF), so those streams
  are configured with `prefer-software`. Frames come out as woven fields, so motion shows combing. *Revisit if* a
  disc has long interlaced content (a deinterlacing shader in the compositor would fix it).

## Menus (HDMV)

- **Menu sounds are verified on synthetic data only.** `disc-menu` carries a `sound.bdmv`; none of the local discs
  has one. *Revisit when* a disc with menu sounds is available.
- **`composition_timeout_pts` and `selection_timeout_pts` are not implemented**, as in libbluray (it only logs them).
  The user timeout is. *Revisit if* a disc relies on them.
- **Initial PSRs are libbluray's `bd_psr_init` defaults**, including region B and profile 2, so traces match
  libbluray. *Revisit if* a disc's program branches on region or profile in a way that matters.
- **Menu keys are not checked against UO masks at libbluray's default restriction level (RELAXED)** inside the
  navigator, as in libbluray; the player refuses masked keys and controls one layer up with a notice.
- **IG in sub-paths is read whole when its playlist opens** (`_preload_ig_subpath`), which reads the whole sub-path
  clip; clips over the preload limit show no menu. *Revisit if* a disc carries a large IG sub-path.

## Subtitles

- **HDMV TextST streams (stream type 0x92) are not decoded.** No local disc carries one. *Revisit when* a disc does.
- **PG carried in sub-paths is not decoded**, as in libbluray (it decodes main-path PG only); such tracks are left out
  of the subtitle menu. *Revisit if* a disc carries its only subtitles in a sub-path.
- **After a seek or a stream switch, the subtitle on screen comes back only if its display set lies after the keyframe
  the read starts at;** otherwise the next subtitle is the first one shown (libbluray behaves the same). *Revisit if*
  this is noticeable on real discs (reading PG from a few seconds earlier would fix it).
- **Subtitle files are not remembered per disc**, and a file dropped on the player before a playlist plays is ignored
  (the file belongs to the open disc).
- **SRT is verified on synthetic data only** (unit tests and `tests/e2e/subtitles.spec.ts`); no real-world SRT corpus
  is tested. Encodings other than UTF-8 need the user's choice in the encoding prompt (no detection).

## ASS subtitles

- **Not loaded yet: subtitles and fonts inside `.mkv` files, and installed system fonts (`queryLocalFonts()`).**
  Both are a later milestone. Fonts come from files picked or dropped with the script and from its `[Fonts]`
  section; a family that is still missing is replaced and named in a notice.
- **WOFF2 fonts are not accepted** (Brotli and table transforms); `.ttf`, `.otf`, `.ttc` and `.woff` are. Fansub
  fonts are TTF/OTF. *Revisit if* a release ships WOFF2.
- **Legacy `Effect` field effects (`Banner`, `Scroll up`, `Scroll down`) are ignored**, and `Comment`, `Picture`,
  `Sound`, `Movie` and `Command` events are skipped. *Revisit if* a real file uses them.
- **Right-to-left text is reordered by Chrome within a style run only**; libass's FriBidi reordering across runs is
  not ported, so mixed-direction lines that change style mid-word can order differently.
- **Lines break as libass does without libunibreak** (spaces and ZWSP only), which is what most ffmpeg builds do.
  CJK text without spaces therefore wraps only at the frame edge, as in those builds.
- **Fonts without TrueType hinting instructions space their glyphs slightly differently from libass.** libass's
  shaper loads glyphs hinted, so FreeType runs its auto-hinter on such fonts and the advances follow the snapped stem
  edges: about 1 px per glyph at the 256 px shaping size, up to ~1 px across a short title on screen. Porting the
  auto-hinter is out of scope. In the TSURUNE corpus this is Chalk Board (the episode title card); it is recorded in
  that fixture's `exceptions.json` and is the only difference left (57 layout differences and 3 frames, all in 2
  events). Glyph shapes are unaffected.
- **Small text keeps up to 1/16 px of Chrome's glyph snapping.** Chrome draws text under about 256 device px from a
  glyph cache that snaps the baseline to whole pixels, so masks are supersampled until text reaches that size, at
  most 8×. Text animated in shape every frame (the direct path) is drawn the same way on the GPU but blurred by the
  canvas filter with one deviation for both axes.
- **Not drawn as libass does:** BorderStyle 4 (libass's background box) is not drawn; vertical `@font` glyphs are
  drawn unrotated; `\be` is folded into the Gaussian (variance 0.5 per pass); a rotated border with `\xbord` ≠
  `\ybord` is dilated axis-aligned in device space. *Revisit if* a real file shows the difference.
- **Verified against one real script so far** (TSURUNE episode 1, its 18 fonts, 2340 sampled times; local gate
  `ASS_LOCAL=1`). The 15 committed synthetic fixtures cover the tag set. *Revisit* by adding scripts to
  `fixtures/local/ass/`.

- **`src/engine/ass/trace.ts` imports its types from `tests/ass-trace/format.ts`.** The import is type-only and the
  module is used only by the trace page, so nothing from `tests/` reaches the player bundle. *Revisit if* the trace
  format moves into the engine (it would then belong in `src/engine/ass/`).
- **The local corpus gate needs Docker and the developer's files**, so CI runs only the synthetic fixtures. *Revisit*
  if a freely licensed real-world script with fonts becomes available to commit.

## Video shaders

- **The final scaler is bilinear (the canvas draw), not mpv's Lanczos.** Anime4K does the real upscaling; what is
  left is a small resize to the window. *Revisit if* the difference is visible.
- **PREKERNEL runs in gamma light**, as the video is delivered; mpv's linear-light option is not implemented.
- **Shaders are compiled as GLSL ES 3.00, which rejects desktop-GLSL habits** such as implicit int to float
  conversion, so some non-Anime4K shaders fail to compile (the error shows in the menu). *Revisit if* a wanted
  shader needs a rewrite pass.
- **Unsupported directives are rejected when the file is added:** `COMPUTE`, `TEXTURE`, `PARAM`, `BUFFER` and
  `OFFSET` (the Anime4K files use none of them), more than 16 `BIND`s per pass, and files over 4 MiB.
- **No in-memory fallback when IndexedDB is unavailable:** the menu opens but sets cannot be chosen that session
  (errors are logged). Chrome's private windows still provide IndexedDB, so this is rare. *Revisit if* users with
  blocked site storage need shaders.
- **`unavailable` is discovered only when a set is first chosen:** the engine creates the WebGL2 backend lazily, so
  until then the menu lists sets as usual, and only after the first choice does it show the unavailable message.
  *Revisit if* users on such browsers find the late message confusing (probe at startup).
- **A pass skipped for an error mid-chain lets later passes bind a same-named texture saved earlier by another
  file,** where libplacebo fails the whole hook. Not reachable with Anime4K.
- **A transient render error (for example a closed `VideoFrame`) turns the set to `error` until it is selected
  again,** instead of costing one frame. *Revisit if* it shows up in practice (treat `InvalidStateError` as per-frame).
- **Resolved: GitHub CI runs the shader E2E tests.** `ubuntu-latest` Chrome provides WebGL2 float render targets
  (SwiftShader) with no extra flags; the fixture-shader tests ran and passed on PR #1 (2026-10-16). The tests still
  skip with a logged reason if a runner lacks them, and the Anime4K and sync tests stay behind `SHADERS_GPU=1`.
- **Note (behaviour, not an issue): `MAIN` is the visible size,** for example 1440x1080 for an anamorphic frame
  (coded 1440x1088, display 1920x1080), as `texImage2D` of a `VideoFrame` gives; confirmed by the Task 1 spike.

## BD-J (milestones 5b-5c)

- **5c timings (Chrome, production build, this machine).** Time from opening the disc to the first frame of the
  title's playlist, as `bdj.firstFrameMs`:

  | Disc | Warm | Cold |
  |---|---|---|
  | A_NEW_ERA | 4,934-4,988 ms (5 runs) | 5,006-5,013 ms |
  | RENTAL_FAMILY | 843-884 ms | 875-916 ms |

  The margin to the 5 s target on A_NEW_ERA is 12-66 ms. About 4.0 s of its time is the disc's own animation and a
  `Thread.sleep(3000)`; about 0.7 s is interpretation. On a slower machine the local 5 s check may fail. *Revisit in*
  5e: the JIT (spec 5c section 4.7, stage 2) is the lever if the margin is needed; stage 1 (intrinsics) replaced the
  5b figure of about 26 s in Node.
- **Open on purpose in the JVM core.** Weak and soft references hold strongly, reference queues stay empty and
  finalizers never run. `long` is a `bigint`. A failed `invokedynamic` call site re-links on each execution (JDK 8
  behaviour, not JVMS §5.4.3). Deep method-handle nesting (about 60k) can overflow the JS stack. `rt-bdj.jar` has no
  socket implementation, so sockets fail with `NoClassDefFoundError` (5e decides network). `SecureRandom` has no
  entropy source (no `/dev/urandom`), so its first use fails. JAR signatures are not verified on the j2se stack path
  we run; whether libbluray checks them elsewhere was not examined. There is no bytecode verifier and there are no
  access checks: no `IllegalAccessError`, no `IncompatibleClassChangeError` for `invokevirtual` on a static method, no
  check that a final method is not overridden.
- **Player settings come from the browser's locale, under BD-J only (5c, ruling R9).** The engine worker derives
  `bd_set_player_setting_str`'s audio, PG and menu languages and the country from `navigator.language`
  (`playerSettingsForLocale`): the language as ISO 639-2/B (`fre`, `ger`, `chi`, the codes discs label streams with),
  the region in lowercase (`us`); anything it cannot map stays unset. They are written to the program's registers only
  when a BD-J title is entered, before its worker boots, so HDMV discs keep the registers' defaults (PSR16-19) and
  their first stream choice is unchanged. libbluray applies them for every disc; an HDMV disc that later enters a
  BD-J title gets them from then on. There is no settings UI yet.
- **Open on purpose in 5c.** A new BD-J worker and JVM start for every BD-J entry, where libbluray keeps one JVM
  across HDMV and BD-J handoffs (deviation 5). The HDMV Navigator is dropped, not suspended, while BD-J runs, so
  libbluray's resume of a suspended object across a BD-J title is lost on mixed discs (deviation 6). The mixed
  HDMV/BD-J synthetic disc has no vm-trace golden, because that harness's libbluray has no JVM (deviation 12).
  SEEK and PSR8 report the requested position, not the EP-map-aligned one, and END_OF_PLAYLIST fires once per
  presentation end where libbluray fires once per open (deviation 13). JVM timers run on the real clock while the
  Node replay's player uses a virtual clock (no effect seen). The intrinsics' loop hooks are pinned by checksum to the
  committed jars: a rebuilt class library fails loudly until the hooks are re-checked. `openDisc` and `loadClips`
  have no read-concurrency cap.
- **Disc directory listings are sorted (5c).** `listBdFilesN` (and the VFS's other directory listings, `vfs.ts`)
  return names in sorted order, where libbluray returns readdir order. A folder the browser hands over has no
  canonical readdir order, so sorted is the one order that is the same on every run and machine.
- **5d picks up:** BD-J graphics (`updateGraphicN`), keys and mouse to Java (VK_KEY, MOUSE), the pop-up key, fonts.

## Audio

- **TrueHD and DTS-HD play through their lossy cores.** The output is a stereo 48 kHz downmix,
  so decoding MLP or XLL would not be audible. *Revisit if* multichannel or high-resolution output is added.
- **A play item without the selected audio stream** gets no audio units. The audio clock then behaves as for any gap
  in the audio (it can drop to buffering until video read-ahead fills). Blu-ray discs carry every stream in every
  play item, so nothing fills the gap. *Revisit if* a real disc shows it.
- **The last E-AC-3 access unit before the end of input is not played** (32 ms), because a group is emitted when
  the next one starts.
- **AC-3 at 44.1 or 32 kHz is ignored** (treated as no sync). Blu-ray AC-3 is always 48 kHz.

## Browsers and devices

- **BD-J on real discs is verified in desktop Chromium only.** Cross-browser support (step 1 of `docs/superpowers/specs/2026-10-16-cross-browser-and-remote-design.md`) was built in parallel with milestone 5 (BD-J). With 5c merged, BD-J titles play in desktop Chromium, on real discs too. The synthetic BD-J disc's E2E tests (`bdj.spec.ts`) also pass in Playwright's Firefox and WebKit, but real BD-J discs in Safari and Firefox, and BD-J on phones and tablets, are unverified and is part of milestone 5's remaining work: the requirements are in that spec's §3.9 (time to first frame on iPhone within M5's target, touch navigation, the BD-J worker in Safari and Firefox, JVM caches in the constrained memory profile). A failed BD-J boot still falls back to the playlist picker.
- **iPhone has no element fullscreen.** Use the installed app (Add to Home Screen); WebKit bug 206854.
- **No background audio on iOS.** Playback pauses when the platform suspends audio.
- **If WebKit reports the AudioContext `suspended` only after the page is visible again,** no pause happens and audio stays suspended while the engine plays, until the user acts.
- **Firefox Android is unsupported.**
- **Android HEVC and USB OTG are unverified.**
- **The iPadOS detection is the one user-agent exception.** `navigator.platform === 'MacIntel'` with touch points in `src/ui/memory-profile.ts`, because iPadOS reports a Mac.
- **Constrained memory profile: IG sub-paths over 64 MB don't preload.** The user sees "This disc's menus need more memory than this device allows." and the disc plays without menus.
- **Canvas-to-`<video>` fullscreen/PiP experiment, left open.** Capturing the canvas into a `<video>` might give iPhone fullscreen and Picture-in-Picture; not tried.
- **Full discs can't practically be opened from a folder on iPhone or iPad.** Safari copies every picked file out of the Files provider before the page sees it: measured on iPadOS 27, a 0.40 GiB clip from a USB drive took 61 s (about 7 MB/s), so a full disc takes an hour or more on every open. No web API avoids it. The landing screen explains the wait after 1.5 s; iOS watching goes through the NAS (spec steps 2–3).
- **Offline when the network answers with an error page (fixed).** Found in the tailnet offline test: an origin that had stopped serving still answered the reload with "404 page not found" over the open connection, and the service worker passed it through. A 404 or 5xx answer to a navigation now gets the cached app, as a network failure does (`src/sw.ts`, `tests/e2e/offline.spec.ts`).
- **Touch pointerup at (0, 0) on the iPad (fixed).** Under remote automation, iPadOS 27 Safari reported a touch's `pointerup` at clientX/clientY 0,0 while `pointerdown` and the synthesized `click` had the real position; taps on menu buttons missed and double taps all fell in the left third. Taps now take their position from the matching `pointerdown` (`tapPoint` in `src/ui/touch.ts`). Whether real fingers do the same is unconfirmed; the fix holds either way.
- **Probe-dependent steps: none needed on the iPad.** It runs the AudioContext at 48 kHz, has worker `requestAnimationFrame` (p95 18.9 ms) and canvas `letterSpacing`, so no resampling, main-thread frame tick or letter-spacing fallback was built. It lacks canvas `filter`, so ASS blur takes the mask path (Task 13). Re-check on the iPhone when convenient.
- **Playwright reuses a running preview server on :4173 locally** (`reuseExistingServer`); stop a stale one after changing source.
- **WebKit on Linux CI runs no real-time playback tests.** On GitHub's GPU-less runners, Playwright's Linux WebKit missed a different set of timing windows on every run (frames presented, remote presses, pauses landing), even on a runner of its own. Tests that need real-time playback skip there (`LINUX_WEBKIT_REALTIME` in `tests/e2e/support.ts`); the landing, capability, folder-picking, layout and offline tests still run. They all run in WebKit on macOS, and real Safari is covered by the real-device test.

### Device probe results

Fill in from `probe.html` on each device.

| Device | Browser/OS | blob-slice-over-4gib | audio-sample-rate | audio-session | worker-raf | hevc | webgl2-float | canvas-filter | letter-spacing | fullscreen | webkitdirectory | relative-path |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| iPad (2026-10-17) | Safari 27.0.1 (iPadOS, desktop UA) | untested (no clip over 4 GiB handed over) | 48000 | present | rAF, p95 18.9 ms | untested | float and half-float | **missing** | works | yes | yes | paths kept |
| iPhone |  |  |  |  |  |  |  |  |  |  |  |  |

## Resolved (for reference)

- **Resolved: large animated text missed the libass pixel budget without GPU canvas rasterization (2026-10-16).**
  The cause was not glyph rasterization but the direct path for runs reshaped every frame: it shrank its
  supersampled canvas with `drawImage` at `imageSmoothingQuality = 'high'`, which Chrome filters differently on CPU
  and GPU canvases (`anim` at 2500/2999 ms gave 736 and 526 differing pixels against 326 and 381 with
  `--disable-gpu`, plus the spin at 5000/5500 ms). The factor is now a power of two halved in bilinear 2:1 steps,
  the same 2×2 box filter as the mask path, so all fixtures pass with and without the GPU on macOS Chrome. The
  `ass` CI job passes on the Linux runners and gates the deploy again; `ASS_BUDGET_SCALE=8` still covers the runners'
  draw time.
- **M4b porting bugs found by the TSURUNE gate (fixed in the port, 2026-10-15).** Runs were snapped to 1/8 px by
  each glyph origin instead of libass's rounding of the first inked glyph's box centre; TrueType fonts that force an
  integer ppem had their ascender and outline size rounded too (only hinted advances are), which put whole lines
  1/32 px high; a fade counted as a shape change, sending the first opaque frame through the 1× direct path. The gate
  went from 66 layout and 112 pixel failures to only the auto-hinter exception above.
- **M4b review fixes (2026-10-15).** The cached coloured layers left the shadow offset out of their key, so two runs
  differing only in `\shad`/`\xshad` (or a `\t` on the shadow distance) drew the shadow at the first one's offset;
  the static event cache was bounded by count only (64 full-frame drawings could hold ~530 MB) and is now also
  bounded to 128 MiB; the controller imported its file sorting from `src/ui` (moved to `src/player/drop-files.ts`);
  subtitle rows were keyed by file name, which collides for same-named files from different folders.
- **ASS rendering differences from Chrome's canvas, found by the TSURUNE gate.** Canvases created with
  `willReadFrequently` (CPU) approximate `blur()` with box passes: deviations under 0.8 px do nothing and larger ones
  step, so mask blurs are a Gaussian in JS. Both CPU and GPU canvases snap the baseline of text under ~256 px to whole
  device pixels (see above). Canvases that are only drawn into are GPU-backed: read-backs of the composited output
  were most of the animated draw time (p95 15 ms → 4 ms).
- **"Underruns" at the end of a playlist were the stream ending, not dropouts.** The output keeps running until the
  last video frame (plus 100 ms) so the clock can finish the picture, and every silent quantum after the audio ran out
  counted as an underrun (about 50 per playlist end; TSURUNE showed 57 from its First Play logo ending). Once all of
  a stream's audio is written the ring is marked draining and that silence is not counted; starting playback clears
  it. The local-disc gate now requires 0 underruns.

- **Milestone 3 real-disc gate passed (2026-10-15).** TSURUNE_TSUNAGARI_1 (HDMV) boots through First Play (a logo,
  then the 119 min feature); Top Menu opens its menu, Enter starts the feature, and its three LPCM tracks play in
  sync with 0 decoder errors. `npm run vm-trace` matches libbluray on TSURUNE for menu → feature (113 entries) and
  pop-up open → close (65 entries), plane hashes included. A_NEW_ERA and RENTAL_FAMILY (BD-J) still open to the
  picker (5c: no longer) with their main features, all tracks in sync.
- **Main-path menus muxed at a clip's start now show.** Playback started the first play item at its first EP map
  entry, skipping an IG display set muxed ahead of the first keyframe, and a PES was only complete at the next unit
  start on its PID, so a menu's last segment waited for the end of the clip. Both now follow libbluray (`_fill_clip`
  packet 0 for first and seamless items; `m2ts_demux` completion by `PES_packet_length`).

- **Looping playlists are no longer picked as the main feature.** BD-J discs can carry playlists that play one
  segment hundreds of times (A_NEW_ERA and RENTAL_FAMILY: `00149`, about 250 min). That one is the BD-J menu's
  background loop (seen in the BD-J spike and the 5b traces), not a decoy maze as first assumed; skipping it for the
  main feature remains right. The main feature is now chosen
  as libbluray's title list does (`disc/main-title.ts`, from `navigation.c`): loops (any segment more than twice)
  and exact duplicates are skipped, then chapters, video, HD audio, duration and stream count decide. The main
  feature is listed first, loops last. Differences: HD audio is judged by coding type (libbluray compares the
  channel-layout field there, which never matches), BD-J "known playlist" hints are not used, and a full tie goes
  to the lower playlist number. The local-disc tests now play `00040` and `00800`.

- **Milestone 2 real-disc gate passed (2026-10-13).** All 10 playable tracks of A_NEW_ERA `00040` (TrueHD core,
  3× AC-3; HEVC video) and RENTAL_FAMILY `00800` (DTS-HD MA core, 5× AC-3) played in Chrome at the local bounds
  (worst 16.9 ms mean / 34.5 ms max), with 0 decode errors and no underruns; each also decoded cleanly in Node
  at 0% and 30% into the film. Since the main-title fix, `LOCAL_DISCS=1 npx playwright test local-discs` covers
  these tracks directly. Not covered by a real disc yet: E-AC-3 and plain DTS (synthetic only for DTS).

- **File version checks** now match libbluray's `bdmv_parse_header`
  (`0100`, `0200`, `0240`, `0300`), checked against a libbluray clone at 448f896.
- **CLPI coding type `0xa0`** reads a stream language, as libbluray does.
- **Case-colliding disc file names** (for example `00001.m2ts` and `00001.M2TS` in one folder)
  are now refused with a `case-collision` error that names both files.
  Before, one of the two was dropped silently.
- **Open-GOP leading-picture skip is verified on the real disc.**
  78 of 123 sampled entry points on `TSURUNE_TSUNAGARI_1` are non-IDR recovery points with leading pictures.
  In Chrome (which reports hardware H.264 support on this machine), 8 seeks all started on open-GOP keyframes
  and skipped 15 leading pictures, with 0 decoder errors and 0 audio underruns.
  The decoder now reports `openGopStarts` and `leadingPicturesSkipped` in telemetry,
  and `LOCAL_DISCS=1 npx playwright test local-discs` repeats the check.
- **The audio worklet's BigInt counter write was measured.** The BigInt load and store take about 21 ns (Node, Apple silicon).
  A whole `renderQuantum` takes under 0.4 µs (this figure includes the writer's work).
  That is under 0.02% of the 2.67 ms budget per 128-frame quantum at 48 kHz, so the counter was kept.
- **The fake `VideoDecoder` can deliver output late** (`asyncOutput` and `deliver()`, with `reset()` leaving
  queued output in place). The fake exposed a real gap: a frame from before a seek that arrived after `reset()`
  would have been presented. `WebCodecsVideoDecoder` now passes on only frames whose chunks it fed since the last reset.
- **The chapter guard is checked directly.** Tests cover skipping a chapter that starts under 0.5 s ahead.
  They also check that "next chapter" on the last chapter leaves the clock advancing,
  with no state change and no seek.
- **The `fsevents` install-script warning** is silenced (`"fsevents": false` in `allowScripts`).
- **Abandoned prefetch reads are cancelled.** `ByteSource.read` takes an `AbortSignal`.
  With a signal, `FileSource` reads through `Blob.stream()`, which measured as fast as `arrayBuffer()` in Chrome
  (200 MB in 84–98 ms vs 83–97 ms on the local disc). `PlaybackPipeline.stop()` and each new item cancel the old reader.
- **Holding or slowly dragging the seek bar snapped back.** On release Chrome can fire a trailing `change`
  after `pointerup`. Once the drag value had been cleared, it carried the old playback time, which seeked back there.
  The seek bar now holds the committed target until the engine reports reaching it, and ignores that repeat.
  Holding a control also keeps the controls from hiding.
- **E2E A/V sync bounds on CI.** The tests stay at 20 ms mean and 50 ms max offset locally (macOS: 11–15 ms and 21 ms).
  Ubuntu 24.04 containers with a PulseAudio null sink measured up to 15 ms mean and 41 ms max on native arm64,
  and up to 19 ms mean and 41 ms max on emulated amd64, which is close to the bounds.
  CI (`.github/workflows/ci.yml`) therefore runs with `SYNC_TOLERANCE_SCALE=1.5` (30 ms / 75 ms).
  *Revisit if* GitHub runs log `sync stats` well inside 20/50 ms, then drop the scale back to 1.
- **A stalled audio output now recovers by itself.** With two Chromes starting audio on one PulseAudio null sink
  (CI's two Playwright workers), the output took over 500 ms to start (heartbeat 8 after 1.2 s), so the stall
  detector moved playback to the wall clock. Audio came back only on the user's next seek or resume, which
  failed the disc3 audio E2E on CI. When the heartbeat moves again during playback, the player now queues a seek
  to the current time, which puts the clock back on the audio output. Reproduced and verified in an Ubuntu 24.04
  container (`--workers=2`): 4 of 4 runs pass with the fix, and the test fails without it.
