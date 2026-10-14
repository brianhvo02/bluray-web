# vm-trace: libbluray trace harness

Runs a disc through real libbluray and prints what its HDMV VM and navigation do, so the TypeScript port can be compared against it entry by entry.

- `Dockerfile`: ubuntu 24.04 (pinned by digest, linux/amd64) with libbluray cloned at `448f896`, `trace.patch` applied, built with meson as a static library, and `vm_trace.c` linked statically against it.
- `trace.patch`: four small changes to libbluray, nothing else.
  - `register.c`: `bd_trace_write_cb` is called after every successful `bd_gpr_write` / `bd_psr_setting_write`, after the PSR callbacks have run.
  - `bluray.c`: `bd_trace_event_cb` is called for every event put in the event queue, and `bd_trace_finished()` reports that the HDMV program has ended and no playlist is playing.
  - `hdmv_vm.c`: the random state always starts at 1.
  - `util/time.c`: `bd_get_scr()` is a counter that the harness advances by 1800 per read (`bd_trace_tick()`).
- `vm_trace.c`: the harness. `vm_trace <disc-dir> <script>` prints the trace (`tests/vm-trace/format.ts`) to stdout. libbluray's own log goes to stderr.
- `build.sh`: `npm run vm-trace:build` builds the image and copies the binary to `out/vm_trace` (gitignored).
- `golden.sh`: `npm run vm-trace:golden` regenerates `tests/vm-trace/golden/*.jsonl` for every script in `tests/vm-trace/scripts/`. Golden files are only ever produced this way, never edited. CI regenerates them and fails on any diff.
- `run.sh <disc> <script>`: libbluray's trace for `fixtures/synthetic/<disc>` and `tests/vm-trace/scripts/<disc>.<script>.keys`, run in the pinned image with the disc mounted read-only. `npm run vm-trace -- <disc> <script>` runs both sides live and prints the first divergence.

## How a run is sequenced

PSR 8 (TIME) is not traced: it follows the presentation position, which is time dependent. Everything else is compared in order and by value; times are diagnostic.

libbluray splits its work over `bd_read_ext()` calls in ways that depend on its event queue, so the harness does not step scripts per call. Each loop iteration first lets the VM run until it is suspended and the queue is empty (`bd_read_ext` with a zero length, repeated), then runs every script step whose `wait` holds, each followed by the same settling, and finally does one 6144-byte read (the clock advances 1800 per read). Waits are state based: `wait title N` holds while the last title entry is N, `wait end` while the program has ended and no playlist plays. The replay in `tests/vm-trace/replay.ts` follows the same sequence.

Events (`title`, `playlist`, `playitem`, `chapter`, `menu`, `popup`, `uo`, `sound`, `still`) are logged when libbluray queues them, which inside a PSR write is during callback dispatch, before that write's `psr` entry. The replay logs them from a PSR listener registered ahead of the Navigator for the same reason.

## Limits

- Item stills (`BD_EVENT_STILL_TIME`) have no trace entry; `still` is the HDMV STILL event only, but the replay logs it from the port's `hold()`, so a disc with item stills would diverge until that is separated.
- Key, mouse and click steps drive libbluray's graphics controller; the replay cannot run them until the graphics controller is ported, and throws if a script uses them (`topmenu` and `play title` work).
- The IG plane hash is not emitted yet (the overlay callback only keeps the palette plane).
