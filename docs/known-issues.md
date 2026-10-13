# Known issues and open items

Items left open on purpose after Milestone 1. Each one says why it was left and
what would change that decision.

## Behaviour

- **Case-colliding disc file names.** `normalizeDiscPaths` upper-cases paths.
  A folder holding both `00001.m2ts` and `00001.M2TS` keeps only one of them.
  Real discs come from case-insensitive filesystems, so this is unlikely to happen.
  *Revisit if* someone reports a disc copied from a case-sensitive filesystem.
- **Abandoned prefetch reads run to completion.** Blob reads cannot be aborted.
  After a seek, any 2 MB read already in flight finishes and its result is thrown away.
  This costs bandwidth, not correctness.
  *Revisit if* seeks feel slow on network-mounted folders.
- **Open-GOP leading-picture skip is unverified on hardware.** The real test disc
  seeks with 0 decoder errors, but nobody checked whether its keyframes hit the skip path.
  *Revisit when* adding the next real-disc test.

## Performance

- **The audio worklet writes a BigInt counter every 128-frame quantum.**
  This has not been measured as a cost.
  *Revisit if* profiling shows audio-thread pressure.
- **Rejected: demux PID peek.** Skipping unwanted PIDs before parsing measured
  103 ms vs 105 ms per 400 MB, which is no gain, so it was not kept.

## Tests

- **The fake `VideoDecoder` emits output synchronously.** It cannot model output
  that arrives late or after `reset()`, so those orderings are only covered
  by the browser (E2E) suite.
- **E2E A/V sync bounds are tight.** The checks are 20 ms average and 50 ms max.
  They pass locally at 15–16 ms but may flake on a slow CI machine.
  *Revisit when* CI is set up; widen the bounds or mark those checks as local-only.
- **The chapter no-op guard is only checked loosely.** The test only confirms
  that no seek was issued; it does not check the clock directly.

## Tooling

- **npm install-script warning for `fsevents@2.3.3`.** This optional macOS file
  watcher comes in through vite/tsx and ships a prebuilt binary, so its install
  script is not needed. Run `npm install-scripts deny fsevents` to silence the warning;
  `esbuild` is already approved in `package.json`.

## Resolved since M1 (for reference)

- **File version checks** now match libbluray's `bdmv_parse_header`
  (`0100`, `0200`, `0240`, `0300`), checked against a libbluray clone at 448f896.
- **CLPI coding type `0xa0`** reads a stream language, as libbluray does.
