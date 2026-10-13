# Known issues and open items

Items left open on purpose. Each one says why it was left and
what would change that decision.

## Behaviour

- **Abandoned prefetch reads run to completion.** Blob reads cannot be aborted.
  After a seek, any 2 MB read already in flight finishes and its result is thrown away.
  This costs bandwidth, not correctness.
  The only way to cancel would be reading through `Blob.stream()`, which adds a chunk copy to every read.
  *Revisit if* seeks feel slow on network-mounted folders.

## Performance

- **Rejected: demux PID peek.** Skipping unwanted PIDs before parsing measured
  103 ms vs 105 ms per 400 MB, which is no gain, so it was not kept.

## Tests

- **E2E A/V sync bounds are tight.** The checks are 20 ms average and 50 ms max.
  They pass locally at 11–15 ms average and 21 ms max but may flake on a slow CI machine.
  *Revisit when* CI is set up; widen the bounds or mark those checks as local-only.
  There is no CI to tune them against yet.

## Resolved (for reference)

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
