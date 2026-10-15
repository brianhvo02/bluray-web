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

## Audio

- **TrueHD and DTS-HD play through their lossy cores.** The output is a stereo 48 kHz downmix,
  so decoding MLP or XLL would not be audible. *Revisit if* multichannel or high-resolution output is added.
- **A play item without the selected audio stream** gets no audio units. The audio clock then behaves as for any gap
  in the audio (it can drop to buffering until video read-ahead fills). Blu-ray discs carry every stream in every
  play item, so nothing fills the gap. *Revisit if* a real disc shows it.
- **The last E-AC-3 access unit before the end of input is not played** (32 ms), because a group is emitted when
  the next one starts.
- **AC-3 at 44.1 or 32 kHz is ignored** (treated as no sync). Blu-ray AC-3 is always 48 kHz.

## Resolved (for reference)

- **"Underruns" at the end of a playlist were the stream ending, not dropouts.** The output keeps running until the
  last video frame (plus 100 ms) so the clock can finish the picture, and every silent quantum after the audio ran out
  counted as an underrun (about 50 per playlist end; TSURUNE showed 57 from its First Play logo ending). Once all of
  a stream's audio is written the ring is marked draining and that silence is not counted; starting playback clears
  it. The local-disc gate now requires 0 underruns.

- **Milestone 3 real-disc gate passed (2026-10-15).** TSURUNE_TSUNAGARI_1 (HDMV) boots through First Play (a logo,
  then the 119 min feature); Top Menu opens its menu, Enter starts the feature, and its three LPCM tracks play in
  sync with 0 decoder errors. `npm run vm-trace` matches libbluray on TSURUNE for menu → feature (113 entries) and
  pop-up open → close (65 entries), plane hashes included. A_NEW_ERA and RENTAL_FAMILY (BD-J) still open to the
  picker with their main features, all tracks in sync.
- **Main-path menus muxed at a clip's start now show.** Playback started the first play item at its first EP map
  entry, skipping an IG display set muxed ahead of the first keyframe, and a PES was only complete at the next unit
  start on its PID, so a menu's last segment waited for the end of the clip. Both now follow libbluray (`_fill_clip`
  packet 0 for first and seamless items; `m2ts_demux` completion by `PES_packet_length`).

- **Decoy playlists are no longer picked as the main feature.** BD-J discs can carry maze playlists that play one
  segment hundreds of times (A_NEW_ERA and RENTAL_FAMILY: `00149`, about 250 min). The main feature is now chosen
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
