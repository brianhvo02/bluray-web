# Milestone 5e: every BD-J disc in the library — design

Date: 2026-10-18
Status: Draft (awaiting the user's approval)
Builds on: `2026-10-17-m5d-bdj-menus-design.md` (5d, merged as PR #7), `2026-10-16-m5c-bdj-playback-design.md`, `2026-10-15-m5b-bdj-jvm-core-design.md`. Parent: `2026-10-12-bluray-web-player-design.md`. Depends in part on the NAS session's step 3 (people and a per-person store; `2026-10-17-nas-server-design.md` and its step-3 successor).

## 1. Intent

After 5d, the user's two local BD-J discs work "as if using a Blu-ray player" on computer, iPhone and iPad, and the user is happy with how they behave. The user's NAS library holds 2,340 discs, 166 of them BD-J. 5e makes **every one of those 166 work as well as the two local discs** (the user: "every one"). "Storage, network, speed" in CLAUDE.md was a placeholder label; the real goal is library coverage.

What a disc saves between viewings (resume points, settings, progress) is kept **on the NAS, per person** (the user), so one person's devices share it and other people's stay separate. People on the NAS are built by the NAS session (step 3); 5e builds the BD-J side on top.

## 2. Where we start: the library scan (2026-10-18)

A read-only scan (over SSH, `ionice`, no video read; results and the id→path map kept outside the repo) booted each BD-J disc's start-up files in our player headlessly, with stub video so every playlist ends at once and no keys pressed, and compared failures with libbluray (`tools/bdj-trace`) on a sample of 30.

| Outcome | Discs |
|---|---|
| Selects a playlist and draws (as the local discs do in this setup) | 69 |
| Selects a playlist, draws nothing (libbluray the same on all 4; probably needs real playback) | 4 |
| Java stops on a JDK class missing from `rt-bdj.jar` | 49 |
| Our player refuses an MPEG-2 video playlist (`selectPlaylist` → 0), Java stalls | 26 |
| Our player refuses a VC-1 video playlist, Java stalls | 18 |
| Missing native, interpreter crash, hang, storage failure | 0 |

Missing classes (first blocker / any): `java.io.FileWriter` 14/19, `sun.net.www.protocol.jar.JarURLConnection` 11/11, `sun.net.www.protocol.http.Handler` 6/12 (BD-Live), `java.rmi.registry.Registry` 5/5, `java.util.TreeSet` 3/10, `sun.reflect.UnsafeStaticFloatFieldAccessorImpl` 3/3, `sun.util.locale.provider.DateFormatProviderImpl` 2/3, `sun.awt.image.ByteArrayImageSource` 2/2 (libbluray also stalls on that disc), `sun.awt.image.URLImageSource` 0/7, and single discs on `IndexColorModel`, `DontCareFieldPosition`, `UnsafeLongFieldAccessorImpl`, `ImageFormatException`, `FileFilter`, `Polygon`. libbluray got further on every sampled missing-class disc except the `ByteArrayImageSource` one. 12 discs try BD-Live HTTP. 9 write files under `/persistent`; 94 look for saved files that don't exist yet (a first run). No ISO in the library is BD-J.

## 3. Decisions

| Topic | Decision | Whose |
|---|---|---|
| Goal | Every BD-J disc in the NAS library works as well as the two local discs | User |
| What "works" means | The automatic check of §5 on every BD-J disc, plus a few discs checked by hand on the iPhone | User agreed (my proposal) |
| MPEG-2 / VC-1 video | 5e makes those discs' menus work and says the video can't play here yet; playing the film is NAS step 4 (Quick Sync re-encode), a separate track | User |
| Saved data | On the NAS, per person; per-browser only for discs opened from a local folder | User |
| People on the NAS | Built by the NAS session in its step 3 ("separate users when pairing"); 5e builds on its API | User; NAS session agreed |
| Speed, JIT | Out of scope: the user is happy with how discs feel; the cold-start deviation stays as accepted in 5d §9 | User ("it behaves fine") |
| Finish line | 5e is done only when saved data works per person on the NAS: the milestone (and its merge to main) waits for the NAS session's step-3 store; the rest of 5e is built meanwhile, with the browser backend first | User ("hold") |

## 4. What 5e builds

### 4.1 The class library covers the library

- Widen `src/bdj-classlib/classes.txt` (and so `rt-bdj.jar`) with what the 166 discs need, collected the way the current list was: from HotSpot's `-verbose:class` in the libbluray harness, run over the library's BD-J discs (copied start-up files, as the scan did), with key scripts that reach their menus. Whole packages may be added where a disc's use is open-ended (for example `java.util` collections), as long as the jar stays reproducible and licensed (GPLv2+CE, with any third-party notices, as 5d did for Xerces).
- Repeat until no disc stops on a missing class: fixing one class often reveals the next.
- Any class that needs natives or intrinsics our JVM lacks is implemented (libbluray-derived in `src/engine`, OpenJDK-derived only in `src/bdj-classlib/intrinsics/`).
- Size: the jar is precached by the service worker for every visitor; growth is measured and reported, and kept proportionate (no whole-JDK import).

### 4.2 MPEG-2 and VC-1 discs

- `selectPlaylist` on a playlist whose video the browser can't decode **succeeds**, as in libbluray: the playlist "plays" with audio, subtitles, IG/BD-J graphics and the clock, without a picture. The disc's Java carries on (its menus, its events, its timers).
- The user sees a clear, once-per-disc notice: this disc's video can't play here yet (wording settled in the plan; no codec jargon needed in the main line).
- No video decoding is added. NAS step 4 later makes the picture appear; until then nothing pretends to show video.
- HDMV discs with MPEG-2/VC-1 get the same behaviour (my call, for consistency): today `UnsupportedCodecError` stops the Player (`state: 'error'`); after 5e the playlist runs without a picture (audio, PG, IG menus, the clock) with the same notice. The change sits in the shared Player path, not only in `PlayerBdjHost`, and is checked against the vm-trace and navigator goldens (no diff) and the HDMV E2E.

### 4.3 BD-Live and other network use

- The HTTP (and any other) URL handler classes exist, so a disc's online check runs; the connection then **fails cleanly**, as libbluray's does offline ("No route to host"-class `IOException`), and the disc carries on. No real network access from BD-J in 5e (BD-Live servers are long gone; anti-goal below).

### 4.4 Saved data that lasts

- BD-J's two storage areas, as libbluray mounts them: `/persistent/<orgId>/<appId>/…` (shared by apps of one organisation) and `/buda/<orgId>/<discId>/…` (one disc).
- The unit of storage is a **scope**, one whole subtree read and written as a snapshot: `persistent/<orgId>` and `buda/<orgId>/<discId>` (ids from the disc's BDJO and `id.bdmv`).
- One `BdjStore` interface with two backends:
  - **NAS** (discs from the NAS, once step 3's API exists): per person, behind the device token. The sketch sent to the NAS session: `GET bdj-store/<scope>` → `{etag, files}` + bytes; `PUT` with `If-Match` replaces atomically; 412 on a stale etag → re-read, merge per file by mtime, retry; proposed quotas 16 MB per scope, 256 MB per person; over quota → the JVM sees "no space" (IOException), as on a full disk. The NAS session's step-3 spec owns the final API.
  - **Browser** (IndexedDB): discs from a local folder, and every disc until the NAS API exists.
  - **Moving to the NAS when it goes live** (my call): a paired device belongs to one person, so the browser's saves for NAS discs belong to that device's person. On the first boot of a scope with the NAS backend, a browser copy of that scope is merged into the person's NAS scope (per file, newer mtime wins, as on a 412), then marked migrated (kept, not deleted, until the NAS write succeeds). Saves for local-folder discs stay in the browser. The IndexedDB layout records each scope's disc source (NAS id or local) from the start, so this works.
- Reads: once per scope at BD-J boot, before the xlet starts (on the start-up path, so an empty scope must answer at once). Writes: debounced (about 2 s after the last file write) and on BD-J stop (title change, close, `pagehide`/`visibilitychange` with `keepalive`). Browsers cap `keepalive` bodies at 64 KB, so a scope bigger than that is flushed with a plain request while the page is still up (the debounce keeps the final flush small or empty); the NAS session agreed the sketch (scopes, etags, 412, quotas, 507 over quota, fast empty GET) and settles body format, atomic replace and the admin "clear saved data" action in its spec.
- The disc's Java sees exactly libbluray's file semantics; only where the bytes live changes. The constrained memory budget for these mounts (5d R16) still applies.

## 5. How "works" is checked

An automatic **library check**, run over every BD-J disc (start-up files copied from the NAS as in the scan, with real or stub video as the step needs), in our player and in libbluray (`tools/bdj-trace`) with the same inputs:

1. The disc reaches its menu (a visible plane, or a playlist with drawing).
2. Arrow keys visibly change the menu.
3. Enter starts a playlist (or a title change).
4. libbluray, given the same presses, does the same (settled-plane hashes and control calls compared as in 5d, R3; where libbluray itself fails, the disc is reported as "libbluray fails too", not as ours).

Plus a few discs checked by hand on the iPhone over the NAS (the user), chosen to cover each failure category the scan found.

Results stay outside the repo (disc names are private: the repo is public). The check's tooling (scripts, reductions) is committed with made-up names only.

## 6. Goals, non-goals, anti-goals

Goals:
1. Every BD-J disc in the library passes the §5 check, or is shown to fail in libbluray too (documented as such).
2. MPEG-2 and VC-1 BD-J discs reach and use their menus, with the notice.
3. Saved data survives between viewings, per person on the NAS, verified with two people on two devices each (one person's iPad and iPhone share saves; the other person's don't see them); browser-local for local folders. 5e is not finished, and not merged, until this works against the NAS session's live store.
4. No regression: the two local discs, the synthetic discs, all goldens (bdj-trace, vm-trace, local), the device-gate behaviour and the desktop 5 s bar stay as they are.

Non-goals:
- Playing MPEG-2 or VC-1 video (NAS step 4).
- Start-up speed work and the JIT.
- Building people/accounts on the NAS (NAS session, step 3).
- Real BD-Live network access.

Anti-goals:
- A disc's saved data leaking to another person, or being lost silently (a failed write is logged and retried, never dropped without a trace).
- Real disc, series or folder names anywhere in the repo, commits or CI logs.
- Load on the NAS drives from checks (read-only, `ionice`, no video reads unless a step truly needs playback, sequential copies).
- Pretending video plays (a black picture with no explanation).

## 7. Constraints

- All of CLAUDE.md: licensing per directory, `src/engine` without UI imports, strict TypeScript, no user-agent sniffing, cross-origin isolation, artifacts rebuilt only by their scripts with CI diffs, goldens never hand-edited, a divergence from libbluray is a porting bug.
- The NAS is touched read-only by 5e; the NAS server code belongs to the NAS session (5e builds against its API; any change to `nas-api.ts`, `nas-client.ts`, `server/` is agreed with that session first).
- Devices: coordinate with the NAS session before using the iPhone/iPad.

## 8. Left to the builder

- How the library check copies, caches and re-runs discs (keep it incremental; the scan's scripts are a starting point, in the scratchpad).
- How classes are collected (harness runs per disc vs whole packages), within §4.1's size and licence rules.
- The exact notice wording for MPEG-2/VC-1, the IndexedDB layout, and the merge on a 412.
- Order of work, except: §4.4's NAS backend waits for the NAS session's API (the plan's last phase; everything else proceeds first, and the branch is not merged before that phase passes); the MPEG-2/VC-1 change lands before NAS step 4 touches playback (tell the NAS session when it has merged).
