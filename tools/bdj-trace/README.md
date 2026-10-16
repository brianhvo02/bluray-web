# bdj-trace: libbluray BD-J native-call trace harness

Runs a disc through real libbluray with BD-J enabled (OpenJDK 8, the `j2se` stack) and prints every JNI native call that libbluray's Java stack makes, so the TypeScript JVM's calls can be compared against it.

- `Dockerfile`: ubuntu 24.04 (pinned by digest, linux/amd64) with apt pointed at snapshot `20261015T000000Z`, libbluray cloned at `448f896`, `trace.patch` applied, built with meson and `-Dbdj_jar=enabled`, and `bdj_trace.c` linked against the installed library. `ca-certificates` is installed from the live archive first, because the https snapshot service needs it and the base image has none.
- `trace.patch`: changes two files of libbluray and nothing else.
  - `src/libbluray/bdj/native/org_videolan_Libbluray.c`: each of the 20 `Java_org_videolan_Libbluray_*` functions computes its result into a local, then prints one trace line through `bdj_trace()` before returning. `bdj_trace()` prints the line, flushes, and, when `BDJ_TRACE_UNTIL` equals the call name, calls `_exit(0)`.
  - `src/libbluray/bdj/native/org_videolan_Logger.c`: `Java_org_videolan_Logger_logN` is traced too.
- `bdj_trace.c`: the harness, `bdj_trace <disc> [--seconds N]`. It calls `bd_open`, registers an ARGB overlay callback that does nothing, sets country `us` and audio, PG and menu language `eng`, calls `bd_play`, and loops on `bd_read_ext`, reading no faster than real time (stream time from `bd_tell_time` against wall time since the last `BD_EVENT_PLAYLIST`) and sleeping 40 ms when a read returns 0 bytes. It stops after `--seconds` (default 60). It sends no keys and prints no events: stdout holds only the trace.
- `build.sh`: `npm run bdj-trace:build` builds the image `bluray-web-bdj-trace`.
- `run.sh <disc> [--until <call>] [--seconds N] [--jvm-option OPT]...`: runs the image with the disc mounted read-only at `/disc`. `<disc>` is a folder name under `fixtures/synthetic` or a path to a disc folder (the one holding `BDMV/`). The trace goes to stdout, libbluray's log and the JVM's own output to stderr.
  - `--until CALL` sets `BDJ_TRACE_UNTIL`: the run ends right after the first line for `CALL`, a JNI name without the `Java_org_videolan_Libbluray_` prefix (`selectPlaylistN`, `selectTitleN`, `logN`).
  - `--jvm-option OPT` (repeatable) is joined into `JAVA_TOOL_OPTIONS`, for example `-verbose:class` or `-verbose:jni`.
  - `BD_DEBUG_MASK` and `BD_DEBUG_FILE` pass through to libbluray.
  - `BDJ_TRACE_PLATFORM` (build.sh and run.sh) replaces `linux/amd64` as the Docker platform. It is for local runs only, in case HotSpot does not run under emulation on your host; leave it unset otherwise. It was not needed on an arm64 Mac with Docker Desktop.

## Trace format

One JSON object per line: `{"call": "<name>", "args": [...], "ret": ...}`. `call` is the JNI name without the `Java_org_videolan_Libbluray_` prefix, `args` leave out the native pointer `np`.

- `jint` and `jboolean`: numbers and `true`/`false`. `jlong`: a quoted decimal string (`"-1"`). Strings: JSON-escaped, `null` for a null string. `void` returns `null`.
- Arrays and objects: `null` when null, otherwise a size. `getTitleInfosN` returns the array length (titles plus 2), `listBdFilesN` the number of names, `getBdjoN` `1`, `getAacsDataN` the byte count, `getPlaylistInfoN` the playlist number.
- `updateGraphicN` args are `width, height, x0, y0, x1, y1, rgbArrayIsNull`; the pixels are not traced.
- `logN` args are `file, line, message` (`error` is not traced).
- `writeRegN` args are `isPsr, num, value, mask`; `readRegN` args are `isPsr, num`.

Calls from several Java threads interleave in the order they reach `printf`.

## Notes

- A disc's first-play BD-J object starts through `bd_play` without a `selectTitleN`; that call appears after the title is chosen (menu input, `Libbluray.selectTitle` by an Xlet). The harness sends no keys.
- The JVM prints `Picked up JAVA_TOOL_OPTIONS: ...` to stderr when `--jvm-option` is used.
