# bdj-trace: libbluray BD-J native-call trace harness

Runs a disc through real libbluray with BD-J enabled (OpenJDK 8, the `j2se` stack) and prints every JNI native call that libbluray's Java stack makes, so the TypeScript JVM's calls can be compared against it.

- `Dockerfile`: ubuntu 24.04 (pinned by digest, linux/amd64) with apt pointed at snapshot `20261015T000000Z`, libbluray cloned at `448f896`, `trace.patch` applied, built with meson and `-Dbdj_jar=enabled`, and `bdj_trace.c` linked against the installed library. `ca-certificates` is installed from the live archive first, because the https snapshot service needs it and the base image has none.
- `trace.patch`: changes two files of libbluray and nothing else.
  - `src/libbluray/bdj/native/org_videolan_Libbluray.c`: each of the 20 `Java_org_videolan_Libbluray_*` functions computes its result into a local, then prints one trace line through `bdj_trace()` before returning. `bdj_trace()` prints the line, flushes, and, when `BDJ_TRACE_UNTIL` is `<call>` and this is that call's first line, or `<call>#<n>` and this is its n-th, calls `_exit(0)`. A mutex keeps the lines and the count whole across Java threads.
  - `src/libbluray/bdj/native/org_videolan_Logger.c`: `Java_org_videolan_Logger_logN` is traced too.
- `bdj_trace.c`: the harness, `bdj_trace <disc> [--seconds N] [--planes] [--keys FILE] [--tail S] [--dump-planes DIR]`. It calls `bd_open`, registers an ARGB overlay callback that keeps a copy of the BD-J plane (see [Planes](#planes)), sets country `us` and audio, PG and menu language `eng`, calls `bd_play`, and loops on `bd_read_ext`, reading no faster than real time (stream time from `bd_tell_time` against wall time since the last `BD_EVENT_PLAYLIST`) and sleeping 40 ms when a read returns 0 bytes. It stops after `--seconds` (default 60). Without `--planes` or `--keys` it prints nothing itself: stdout holds only the trace, as the golden files expect.
- `build.sh`: `npm run bdj-trace:build` builds the image `bluray-web-bdj-trace`. The build context is a temporary copy of this folder plus `src/engine/ass/default-font.ttf` (see [Fonts](#fonts)).
- `run.sh <disc> [--until <call>[#<n>]] [--seconds N] [--jvm-option OPT]... [--planes] [--keys FILE] [--tail S] [--dump-planes DIR]`: runs the image with the disc mounted read-only at `/disc`. `<disc>` is a folder name under `fixtures/synthetic` or a path to a disc folder (the one holding `BDMV/`). The trace goes to stdout, libbluray's log and the JVM's own output to stderr.
  - `--until CALL` sets `BDJ_TRACE_UNTIL`: the run ends right after the first line for `CALL`, a JNI name without the `Java_org_videolan_Libbluray_` prefix (`selectPlaylistN`, `selectTitleN`, `logN`). `--until CALL#N` ends it after the N-th line for `CALL` (`selectPlaylistN#2`: after the playlist that follows the first one). The harness reads in real time, so a run past a playlist takes at least that playlist's duration.
  - `--jvm-option OPT` (repeatable) is joined into `JAVA_TOOL_OPTIONS`, for example `-verbose:class` or `-verbose:jni`.
  - `--planes` adds a `{"plane":"flush",...}` line at every ARGB overlay flush.
  - `--keys FILE` replays a key script (see [Key scripts](#key-scripts)) and implies `--planes`. The run ends `--tail` seconds (default 5) after the script's last step, or at `--seconds`.
  - `--dump-planes DIR` writes `DIR/<k>.png` at flush `k` (created if missing, mounted at `/planes`; the files belong to root on Linux hosts). PNG compression slows the drawing thread, so a time-driven animation draws fewer frames than without it (see [Planes](#planes)). Never commit PNGs from local discs.
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

## Planes

libbluray hands BD-J graphics to the harness as ARGB overlay operations (`bdpriv_bdj_osd_cb` in `bluray.c`, `BD_ARGB_OVERLAY_*` in `decoders/overlay.h`), all on the IG plane, from the Java thread that draws. The harness keeps one 1920×1080 plane of 32-bit ARGB words (non-premultiplied, as BD-J's `int[]` back buffer):

- `INIT` and `CLOSE` clear it to 0 (transparent black). An `INIT` smaller than 1920×1080 keeps its pixels at the top left.
- `DRAW` copies the `w`×`h` rectangle from `argb` (stride `stride`) to `(x, y)`, clipped to the plane.
- `FLUSH` counts flush `k` (1, 2, … from the start of the run) and prints `{"plane":"flush","n":<k>,"hash":"<8 hex>","t":<ms>}`, where `t` is wall-clock milliseconds since the harness started (informative only; it varies between runs). With `--dump-planes` it writes `<k>.png` (RGBA, 8 bits per channel, straight alpha).

**Hash.** FNV-1a, 32-bit, over the plane's 1920×1080 words in row-major order (row 0 first, left to right), each word fed as its 4 little-endian bytes (`B`, `G`, `R`, `A` for ARGB `0xAARRGGBB`): start at `h = 0x811c9dc5`, then for each byte `h = (h XOR byte) * 0x01000193 mod 2^32`. Printed as 8 lowercase hex digits. In TypeScript, over a `Uint32Array` of ARGB words:

```ts
let h = 0x811c9dc5;
for (const v of plane) for (let b = 0; b < 32; b += 8) h = Math.imul(h ^ ((v >>> b) & 0xff), 0x01000193) >>> 0;
const hex = h.toString(16).padStart(8, '0');
```

A fully transparent plane hashes to the same value every time, so an empty flush is recognisable. Flush counts are not stable during animations: libbluray's Java stack draws time-driven animations (A_NEW_ERA's logos and menu fade-in) with as many frames as it manages, so `n` differs between runs, but the settled planes do not (A_NEW_ERA's main menu settles on `4bc306b4` in every run). Compare hashes at settled points, which `wait still` reaches.

## Key scripts

`--keys FILE` replays a script in the `.keys` syntax of `tests/vm-trace/scripts/` (one step per line, `#` starts a comment), with these steps:

- `wait flush <k>`: until flush `k` has happened (the `n` of the flush lines).
- `wait still <ms>`: until the plane has flushed at least once since the previous step and then not again for `<ms>` milliseconds of wall time. This is the wait for a settled menu, after the disc's own start-up or after a key, because flush counts vary (see [Planes](#planes)).
- `wait playlist <n>`: until the last `BD_EVENT_PLAYLIST` was playlist `n`. `wait title <n>`: the same for `BD_EVENT_TITLE`.
- `key <name>`: `bd_user_input(bd, -1, key)` with no flags, so libbluray sends pressed, typed and released. Names: vm-trace's `up`, `down`, `left`, `right`, `ok`, `topmenu`, `popup`, `0`…`9`, plus `red`, `green`, `yellow`, `blue`, or a `keys.h` name (`BD_VK_UP`, `BD_VK_ENTER`, `BD_VK_ROOT_MENU`, `BD_VK_POPUP`, `BD_VK_MOUSE_ACTIVATE`, `BD_VK_0`…`BD_VK_9`, `BD_VK_RED`, `BD_VK_GREEN`, `BD_VK_YELLOW` (libbluray spells it `BD_VL_YELLOW`, also accepted), `BD_VK_BLUE`).
- `mouse <x> <y>`: `bd_mouse_select(bd, -1, x, y)` (`BDJ_EVENT_MOUSE`). `click <x> <y>`: the same, then `bd_user_input(bd, -1, BD_VK_MOUSE_ACTIVATE)`. Coordinates are in 1920×1080 plane space.

libbluray runs in real time, so a script never sleeps for a fixed time: the harness checks the current step's wait between reads and only then sends the next steps, and key and mouse steps run at once, one after another. There is no `wait ms`; `wait still` covered every case met so far. Each step that runs prints `{"script":"step","n":<i>,"step":"<line>","flushes":<count>,"t":<ms>}` (`n` counts from 0, `flushes` is the count at that moment), and the run ends with `{"script":"end","n":<steps run>,"why":"done"|"limit"|"error","flushes":<count>,"t":<ms>}`.

Example, A_NEW_ERA's main menu (playlist 00149 plays behind it):

```
wait playlist 149
wait still 1500   # the menu has faded in
key right         # PLAY -> CHAPTERS: one flush
wait still 1000
key left          # back to PLAY
wait still 1000
```

## Fonts

libbluray is built with fontconfig off, so `java.awt.BDFontMetrics` resolves the JRE logical font names to files under `java.home/lib/fonts/` (`/usr/lib/jvm/java-8-openjdk-amd64/jre/lib/fonts/`), which the headless JDK does not ship. The image installs the bundled `src/engine/ass/default-font.ttf` as `/usr/local/share/fonts/default-font.ttf` and links every one of those files to it, so libbluray resolves them all to that font and prints no `Can't resolve font` errors (it printed 24 before):

| logical name (`<name>.<style>`, style 0 plain, 1 bold, 2 italic, 3 bold italic) | files (styles 0, 1, 2, 3) |
| --- | --- |
| `serif` | `LucidaBrightRegular.ttf`, `LucidaBrightDemiBold.ttf`, `LucidaBrightItalic.ttf`, `LucidaBrightDemiItalic.ttf` |
| `sansserif`, `dialog`, `default` | `LucidaSansRegular.ttf`, `LucidaSansDemiBold.ttf`, `LucidaSansOblique.ttf`, `LucidaSansDemiOblique.ttf` |
| `monospaced`, `dialoginput` | `LucidaTypewriterRegular.ttf`, `LucidaTypewriterBold.ttf`, `LucidaTypewriterOblique.ttf`, `LucidaTypewriterBoldOblique.ttf` |

So every logical name in every style is `default-font.ttf`, with no synthetic bold or italic beyond what libbluray's FreeType code does itself. A font a disc names that is not in this table falls back to `default.<style>` in `BDFontMetrics.getFontMetrics`, which is the same file. Fonts a disc ships (`dvb.fontindex`, a BDJO's default font) are read from the disc as before. bluray-web's BD-J font natives resolve the same names to the same file.

## Notes

- A disc's first-play BD-J object starts through `bd_play` without a `selectTitleN`; that call appears after the title is chosen (menu input, `Libbluray.selectTitle` by an Xlet). The harness sends no keys unless `--keys` is given.
- The JVM prints `Picked up JAVA_TOOL_OPTIONS: ...` to stderr when `--jvm-option` is used.

## Golden trace

`golden.sh` (`npm run bdj-trace:golden`) writes `tests/bdj/golden/disc-bdj.jsonl`, the trace of `fixtures/synthetic/disc-bdj` up to the second `selectPlaylistN` (TitleXlet plays playlist 00000, and again when it ends), and `tests/bdj/golden/disc-bdj-mixed.jsonl`, the trace of `fixtures/synthetic/disc-bdj-mixed` up to its first `selectPlaylistN` (see below). Both are reduced to the control calls (`selectTitleN`, `selectPlaylistN`, `seekN`, `selectAngleN`, `selectRateN`, `writeRegN`, `setUOMaskN`, `setKeyInterestN`, `soundEffectN`, `setVirtualPackageN`). Diagnostic calls are left out because they vary between runs: `logN` carries timing and `cacheBdRomFileN` a random cache directory name. CI regenerates the files and fails on any diff (`.github/workflows/bdj-trace.yml`). Never edit it by hand.

The disc is BD-J only (First Play and title 1 are BD-J objects). `selectTitleN` is only reached for HDMV titles (`BDJLoader` to `Libbluray.selectHdmvTitle`), so this disc does not exercise it.

`disc-bdj-mixed` (`scripts/make-bdj-mixed-disc.ts`, xlets in `tests/bdj/xlets/src/bdjweb/mixed/`, packed into `tests/bdj/xlets/mixed.jar` by `tools/bdj-classlib/pack.sh`) hands over in both directions: First Play is BD-J (HdmvTitleXlet starts HDMV title 1 through its `TitleContext`: `selectTitleN(1)`, then libbluray's `_play_hdmv` and `_stop_bdj`), title 1's movie object plays playlist 00000 and then does `JumpTitle 2` (`_play_bdj`), and BD-J title 2 (PlaylistXlet) selects playlist 00001. The vm-trace harness cannot drive this disc: its libbluray is built without a JVM, so `bd_play` ends at once with `BD_EVENT_ERROR` on the BD-J First Play, before any HDMV title runs.
