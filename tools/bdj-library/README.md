# bdj-library: the BD-J library check

Measures how many of the BD-J discs in the developer's NAS library work in our player as they do in libbluray (milestone 5e, spec `docs/superpowers/specs/2026-10-18-m5e-bdj-library-coverage-design.md` §5). Every disc's start-up files are copied once, then each disc runs one generic key script in our player and in libbluray (`tools/bdj-trace`), and the two runs are compared at settled points (5d's Ruling R3).

**Privacy.** The repo is public and disc names are private. Everything the tool learns about real discs stays in `$BDJ_LIBRARY_DIR` (default `~/.cache/bluray-web/bdj-library`, outside the repo): the copies, the id→path map, raw runs, results and the summary. Discs are named by id only: the first 10 hex digits of the SHA-1 of the disc folder's path on the NAS. The tool prints ids and counts, never paths. Tests use made-up runs.

## Commands

- `npm run bdj-library:sync -- [--roots auto|<dir>,<dir>...] [--host H] [--dry-run]` (`sync.ts`)
  - Finds the BD-J discs on `ssh mediaserver` (`--host` or `$BDJ_LIBRARY_HOST`): a folder with `BDMV/index.bdmv` and at least one `BDMV/BDJO/*.bdjo`. `--roots auto` (the default) searches every `/mnt/drv*` folder, the server's library mounts.
  - Read-only on the NAS: every `find` and `tar` runs under `ionice -c3 nice -n19`, `BDMV/STREAM` and `BDMV/BACKUP` are pruned from the search and `STREAM` from the copy (no clip is ever read), and discs are copied one at a time.
  - Copies `BDMV` (without `STREAM`) and `CERTIFICATE` with tar over ssh, the path going on stdin, because rsync skipped paths with spaces or non-ASCII characters. A copy goes to `discs/.tmp-<id>/` and replaces `discs/<id>/` only once its files match the NAS list.
  - Writes a stub `BDMV/STREAM/<clip>.m2ts` per `CLIPINF/<clip>.clpi`: one aligned unit (32 source packets) of null TS packets. The player's readability check passes and every playlist ends at once.
  - Incremental: the NAS file list of each disc (path, size, mtime; `manifests/<id>.tsv`) is compared with the one recorded at its last copy, and an unchanged disc is skipped. A copy with no recorded list (one seeded from elsewhere) is adopted when its file sizes match. A remote listing or a disc copy that takes over 10 minutes is killed and reported (`no answer within 10 min` / `copy not done within 10 min`).
  - Writes `map.tsv`: `id`, `bdj` (1 when `index.bdmv` names a BD-J object), `fingerprint` (hash of the NAS file list) and `path`.
- `npm run bdj-library:check -- [--only <id>...] [--ours-only] [--force] [--jobs N] [--lib-jobs N] [--no-run]` (`check.ts`)
  - Runs `generic.keys` on every disc of `map.tsv` with `bdj` 1. Our side runs `tests/bdj/replay-player.ts` (the real `Player`, BD-J in process) in one child process per disc (`check.ts --run-ours <dir> <out>`), killed at 150 s, `--jobs` at a time (default 6). libbluray's side runs `tools/bdj-trace/run.sh <dir> --keys generic.keys --seconds 140 --wait-timeout 60 --tail 5`, killed at 150 s, `--lib-jobs` at a time (default 3). Ours runs first, then libbluray, so the two phases don't slow each other (both wait in wall time).
  - Both sides use the same limits: each step may wait 60 s, a run ends at 140 s, and it goes on 5 s past the script's end.
  - Incremental: each phase writes `raw/<id>.ours.stamp` or `raw/<id>.lib.stamp` (`{ stamp, fingerprint }`) as soon as that disc's run is in, so an interrupted check resumes where it stopped. Our run is reused while the disc's fingerprint and the contents of `src/`, `tests/bdj/`, `tools/bdj-library/` and the script are unchanged, and libbluray's while the fingerprint, the `bluray-web-bdj-trace` image and the script are. `--only` re-runs the given discs, `--force` re-runs everything, `--ours-only` reuses libbluray's runs where present and runs none, and `--no-run` only reclassifies. `--jobs` and `--lib-jobs` take a whole number from 1 to 64.
  - Each libbluray run names its container `bdjlib-<id>-<attempt>` (`run.sh --name`), and the 150 s kill `docker kill`s it before killing the process group (the docker CLI dying would leave the container running). A crashed run, one with no script end line (HotSpot under amd64 emulation sometimes dies at once with a SIGSEGV in `libzip.so`, or the run was killed), is run once more. On SIGINT or SIGTERM every running child is killed the same way.
  - Writes `raw/<id>.ours.json` (the RunRecord), `raw/<id>.ours.json.tmp.log` (the Java log), `raw/<id>.lib.jsonl`, `.lib.err` and `.lib.meta.json`, then `results/<id>.json` and `summary.md`.

## The generic script

`generic.keys` (the `.keys` syntax of `tools/bdj-trace/README.md`, Key scripts):

```
wait menu 1500
key right
wait still 1000
key down
wait still 1000
key ok
wait playlist any
```

`wait menu 1500` (Ruling R2) holds once the flushed plane is visible (a pixel with non-zero alpha: `GraphicsPlaneReader.visible()` in ours, the same test over the harness's plane at each flush) and has not flushed for 1500 ms, so a blank start-up frame never satisfies it. A menu that stays visible but keeps flushing for 30 s (an animation) satisfies it too: the step is marked `animated` and its hash is not compared, only that it was visible. An init or close, which clears the plane, makes it invisible at once.

`wait playlist any` holds once any playlist starts after the previous step: a `BD_EVENT_PLAYLIST` in the harness (`bdj_trace.c`), a `chapters` event in our replay (`tests/bdj/key-script.ts`, `replay-player.ts`). `wait title any` works the same in the harness.

## RunRecord

One run of the script on one disc by one side (`classify.ts`):

| field | meaning |
|---|---|
| `side` | `ours` or `libbluray` |
| `end` | `done` (the script and its tail ran), `timeout` (a step's wait did not hold in 60 s; that step is the first one missing from `steps`), `limit` (the run reached 140 s), `bdj-failed` (our player gave up on BD-J), `error` (player or harness failure), `killed` (the 150 s kill), `no-output` (the process left no record) |
| `endDetail` | why it failed (a message, paths scrubbed) or null |
| `steps` | each step that ran: `n`, `step` (its text), `hash` for `wait menu` and `wait still` steps (the settled plane: the last flush before the step), `animated` for a `wait menu` step that held on an animated menu (no hash), and `calls`: how many control calls the run had made before the step ran |
| `calls` | the control calls (`tests/bdj/format.ts` `CONTROL_CALLS`) in order, through the run's tail (libbluray: up to the script's end line) |
| `endHash`, `flushes` | the last flushed plane, and the number of flushes |
| `missingClasses` | class-library gaps (Task 2's work): platform classes Java could not load (every `NoClassDefFoundError`, and every `ClassNotFoundException` of a platform class: `java.`, `javax.`, `sun.`, `org.dvb.`, ...; not `org.videolan.` probes, nor a disc's own obfuscated classes such as `org.w3c.dom.a`), missing natives (`UnsatisfiedLinkError`, as `native: <name>`) and methods missing from platform classes (`NoSuchMethodError`, as `method: <name>`). Ours catches them where the throwable is made (Java often swallows them); both sides also read them from the log (`gapOf`) |
| `rejectedPlaylists` | `selectPlaylistN` calls that returned 0, with the playlist's first video codec from its `.mpls` |
| `wallMs` | the run's wall time |

`results/<id>.json` holds `{ id, fingerprint, oursStamp, libStamp, ours, lib, verdict, detail, checkedAt }`.

## How a disc is judged

`progress(run)` says what a run achieved:

- **menu**: a settled plane (any `wait menu` or `wait still` step, or the end plane) is not the empty plane (`EMPTY_PLANE_HASH`), or the `wait menu` step held on an animated menu.
- **arrows**: a real change: the settled plane after `key right` differs from the one before, or the one after `key down` from the one after `key right`, both steps with a settled plane and one of the two visible. After an animated `wait menu` step (no settled plane), only the second (step 2 to 4) can count.
- **ok**: after `key ok`, a `selectTitleN`, a successful `selectPlaylistN` of a playlist other than the last one before it, or a `seekN` (a menu that plays its feature from a chapter of the playlist behind it).

`compareRuns(ours, lib)` compares the runs step by step:

- Up to `key ok`, for each step both ran: the set of distinct starting calls made since the step before (`selectPlaylistN` of a playlist ≥ 0 that succeeded, `selectTitleN`, `seekN`; Ruling R3), then the step's settled hash (not for an `animated` step, on either side). Only starting calls, and as a set, because everything else (register writes, rates, UO masks, key interest) and the number of times a menu loops its background playlist move with the stub streams' timing, which differs between the two sides.
- After `key ok`, where the disc plays and the two sides loop at their own pace: the first call that starts something (`selectTitleN`, `selectPlaylistN`, `seekN`).
- When libbluray stopped first: it must agree on every step both ran, and the starting calls it made after its last step must be among ours up to our next step; then its run is a prefix of ours (`libPrefix`).

`classify(ours, lib)` gives the first verdict that applies:

1. **works**: ours achieved menu, arrows and ok, and libbluray agrees: the runs are equal (`same as libbluray`), or libbluray stopped at an earlier step (stub streams) and its run is a prefix of ours (`libbluray stopped early (stub): ...`). Without a libbluray run, ours alone decides (`not compared`).
2. **missing-class**: ours fell short with a class-library gap (the first one named), whatever libbluray did: libbluray never lacks a JDK class. When libbluray failed too, the detail adds `libbluray (stub) also: ...`.
3. **unsupported-video**: ours fell short and refused a playlist with MPEG-2 or VC-1 video (the same).
4. **error**: our run failed hard (`bdj-failed`, `error`, `killed`, `no-output`), with the reason. Before libbluray-fails-too, so libbluray failing never hides it.
5. **libbluray-fails-too**: libbluray failed on its own (`libFailed`: its run ended in an error, a crash or no output, or it never selected a playlist, or never showed a visible plane), and ours fell short too.
6. **stall**: ours never reached a menu, stopped at an earlier step than libbluray, or stopped where libbluray did with the same run (`same as libbluray: ...`).
7. **diverges**: otherwise, with the first difference. This includes ours passing every step while libbluray disagrees on a step both ran, or runs every step without ever selecting a playlist: a contradiction, not libbluray failing on stub streams.

The settled-point rule is 5d's R3: settled hashes and calls, not flush counts. Stub streams make libbluray do less than it does with real video (RENTAL_FAMILY selects its menu playlist and draws nothing), which is why libbluray falling short is reported as such and never as ours.

## Files

- `sync.ts`, `check.ts`: the commands above.
- `classify.ts`: `RunRecord`, `discId`, `gapOf`, `parseLibblurayRun`, `missingClassesFromLog`, `progress`, `compareRuns`, `libFailed`, `classify`. No disc, file or process access.
- `generic.keys`: the script.
- `check.test.ts`: `classify` on made-up runs, `discId`, `parseLibblurayRun` and the script.
