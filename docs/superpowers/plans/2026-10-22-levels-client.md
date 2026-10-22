# Quality Levels in the Player (Step 4, Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The viewer plays a NAS disc at a re-encoded quality level: the pre-flight picks one automatically and lists the others, a Quality menu switches level during playback, and MPEG-2/VC-1 discs play with a picture.

**Architecture:** The NAS side (phase 1) already serves each level as another version of the disc (`GET discs/<id>/levels`, `manifest?level=&audio=`, `files/...?level=&audio=`, `DELETE viewing`), and `RemoteDiscSpec.query` already carries `level=&audio=` to `HttpTransport`. This plan adds the client: shared level types and `NasClient` calls, a video capability probe, a pure level model (auto choice, rows, audio number), a per-NAS level session that holds the open disc's level and leases, the engine's `setLevel` (swap manifest and byte source, restart the playlist session at the current time), the pre-flight's level list, the Quality menu, the level badge, and an E2E over a software-encoding NAS stand-in.

**Tech Stack:** TypeScript (strict), React 19, Vitest, Playwright; the NAS stand-in runs the server with `LEVELS_BACKEND=x264`.

**Spec:** `docs/superpowers/specs/2026-10-19-lower-quality-design.md` (§3, §5.2, §6.4, §7, §8). Interface notes from BD-J 5e: `docs/superpowers/specs/2026-10-18-m5e-bdj-library-coverage-design.md` §9, and the BD-J session's answers recorded under "Decisions" below.

## Global Constraints

- `src/engine/` must not import from `src/ui/` or `src/player/`; `import type` for type-only imports; TypeScript strict with `noUnusedLocals`/`noUnusedParameters`.
- Made-up names only in tests, fixtures and commit messages (Starfall Wanderer etc.); never a real title.
- No user-agent sniffing. "Phone" is the constrained memory profile or a small screen: `Math.min(screen.width, screen.height) <= 900` (spec: `matchMedia('(max-width: 900px)')` on the shorter side). HDR display: `matchMedia('(dynamic-range: high)')`.
- The auto rule (spec §3): computer → the first available level, in the server's order, whose rate × 1.1 fits the measured connection, Original when it fits; phone → `phone-720` unless the viewer picks higher; MPEG-2/VC-1 → never Original. Nothing fits → the available level with the lowest rate.
- Level rates: a re-encoded level's rate is its `budgetMbps` (padding travels, spec §5.2); Original's is the playlist's bytes × 8 ÷ duration, as `bufferPlan` computes today.
- Busy copy, verbatim (spec §6.4): `The NAS is busy re-encoding for others. This will play at original quality.` and, when Original can't play, `The NAS is busy. Try again in a few minutes.`
- Badge copy (spec §7): `<label> · re-encoded on the NAS` (for example `1080p · re-encoded on the NAS`).
- Auto picks once, at open; switches are the viewer's (no silent switching).
- Works on every route: everything goes through `NasClient` requests and `RemoteDiscSpec.query`, which the WebRTC route already carries.

## Decisions (from the BD-J session, 2026-10-22, on main 32dd53e)

- The BD-J worker reads MPLS and CLPI itself (`bdj-worker.ts` `openDisc`/`loadClips`) and answers Java's playlist info from them; it never reads `.m2ts`. **It keeps reading the original version** (no `level` query, the original manifest), so Java sees the disc as it is and saved data keeps its disc id. `RemoteDiscSpec` gains `original?: DiscManifest` for that.
- A level's MPLS keeps PG, PiP PG and IG STN entries in their original numbers and order (checked in `server/src/levels/mpls-writer.ts`); only audio collapses to the one kept track (number 1), and secondary audio/video go. PSR2 from Java or HDMV therefore keeps meaning; PSR1 does not.
- `PlayerBdjHost` (`deps.disc`) and the HDMV `Navigator` hold the engine's `DiscModel`; `setLevel` hands them the new model.
- `picture` (no-picture mode, paced reads R10, end at EOF R11, the decoder) is fixed per playlist session, so `setLevel` must **restart the playlist session through the playlist-start path** at the current time, never only seek inside it.
- A disc program's own audio choice at a level (PSR1 naming a track the level doesn't carry) is ignored: the level's track keeps playing. Switching audio at a level is done from the player's Audio menu, which reopens the level with that `audio`. Recorded in `docs/known-issues.md` (Task 8).

## Review Focus

1. A disc program writes PSR1 to a track the level doesn't carry, mid-play → the kept track keeps playing, no error (Task 4 test `ignores a PSR1 change to a track the level does not carry`).
2. A NAS without an encoder (`levels` answers 404) → the pre-flight looks and plays exactly as today, Original only (Task 3 test `offers Original alone when the NAS has no levels`, Task 1 test `levels answers null on 404`).
3. Switching level while paused → still paused, at the same time (Task 4 test `setLevel keeps a paused disc paused at its time`).
4. The NAS is busy when the viewer switches (manifest 503 `busy`) → the current level keeps playing and the busy message shows (Task 5 test `a busy NAS keeps the current level and says why`).
5. Closing the disc, opening another, or switching level → the old lease is released once with `DELETE viewing` (Task 5 test `releases the old lease after a switch and on close, once each`).

---

### Task 1: Shared level types, `NasClient` level calls and the level query

**Files:**
- Modify: `src/engine/disc/nas-api.ts` (add the level types)
- Modify: `server/src/levels/levels.ts:6`, `server/src/levels/level-service.ts:26-35` (import the shared types instead of declaring them)
- Modify: `src/ui/nas/nas-client.ts` (`manifest` at ~605; add `levels`, `releaseViewing`)
- Modify: `src/ui/nas/disc-spec.ts:16` (`nasDiscSpec`)
- Modify: `src/engine/disc/disc-spec.ts:20-33` (`RemoteDiscSpec.original`)
- Test: `src/ui/nas/nas-client.test.ts`, `src/ui/nas/disc-spec.test.ts`

**Interfaces:**
- Produces (in `nas-api.ts`):
  - `type LevelId = 'original' | 'h264-1080' | 'phone-720' | 'hevc-1080' | 'hevc-1080-hdr' | 'h264-1080-sdr'`
  - `type LevelReason = 'unplayable' | 'no-encoder' | 'no-hevc' | 'no-hevc10' | 'no-hdr-display' | 'busy'`
  - `interface LevelInfo { level: LevelId; label: string; budgetMbps: number; available: boolean; reason?: LevelReason }` (readonly fields, as the server's)
  - `interface LevelAt { level: LevelId; audio: number }` (audio is 1-based, as PSR1)
- Produces (in `NasClient`):
  - `levels(discId: string, q: { hevc: boolean; hevc10: boolean; hdr: boolean; audio: number }): Promise<LevelInfo[] | null>`: `null` on a 404 (no encoder, or an old NAS); other errors throw as other calls do.
  - `manifest(discId: string, at?: LevelAt): Promise<DiscManifest>`: no query for `undefined` or `original`; a 503 with `error: 'busy'` throws `NasBusyError` (new, exported from `nas-client.ts`, `message` = the body's `message`).
  - `releaseViewing(discId: string, at: LevelAt): Promise<void>`: `DELETE discs/<id>/viewing?level=&audio=`; never throws (logs).
- Produces: `levelQuery(at: LevelAt | undefined): string | undefined` in `src/ui/nas/disc-spec.ts` (`undefined` for Original), and `nasDiscSpec(base, token, manifest, discFetch, level?: { at: LevelAt; original: DiscManifest })` setting `query` and `original`.
- Produces: `RemoteDiscSpec.original?: DiscManifest` (doc: the original version's manifest, for the BD-J worker, when `manifest` is a level's).

- [ ] **Step 1: Write the failing tests**

```ts
// nas-client.test.ts
it('levels asks with the device flags and audio, and answers null on 404', async () => {
  // fake fetch records the URL; first answer 200 { levels: [...] }, second 404
  expect(urlOf(0)).toMatch(/discs\/d1\/levels\?hevc=1&hevc10=0&hdr=0&audio=2$/);
  expect(await second).toBeNull();
});
it('manifest at a level asks with level and audio, and Original with neither', async () => {
  expect(urlOf(0)).toMatch(/discs\/d1\/manifest\?level=phone-720&audio=1$/);
  expect(urlOf(1)).toMatch(/discs\/d1\/manifest$/);
});
it('manifest throws NasBusyError with the NAS message on 503 busy', async () => {
  await expect(nas.manifest('d1', { level: 'h264-1080', audio: 1 })).rejects.toMatchObject({ name: 'NasBusyError', message: 'The NAS is busy re-encoding for others. This will play at original quality.' });
});
it('releaseViewing sends DELETE viewing and swallows errors', async () => { /* method DELETE, query level=h264-1080&audio=3; a 500 resolves */ });
// disc-spec.test.ts
it('a level spec carries the level query and the original manifest; Original carries neither', () => {
  expect(levelQuery({ level: 'phone-720', audio: 2 })).toBe('level=phone-720&audio=2');
  expect(levelQuery({ level: 'original', audio: 2 })).toBeUndefined();
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/ui/nas/nas-client.test.ts src/ui/nas/disc-spec.test.ts -t "level|Level|manifest|releaseViewing"`
Expected: FAIL (`levels is not a function`, `levelQuery` not exported).

- [ ] **Step 3: Implement** the types, the three `NasClient` methods, `NasBusyError`, `levelQuery`, the `nasDiscSpec` parameter and `RemoteDiscSpec.original`; switch the server to `import type { LevelId, LevelInfo, LevelReason } from '../../../src/engine/disc/nas-api'` (keep its `LABELS` and logic).

- [ ] **Step 4: Run the tests and the server suite**

Run: `npx vitest run src/ui/nas server/src/levels && npx tsc -b`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit** — `git commit -m "feat(levels): shared level types, NasClient levels, manifest at a level and releaseViewing"`

---

### Task 2: Video capabilities

**Files:**
- Create: `src/ui/video-caps.ts`, `src/ui/video-caps.test.ts`

**Interfaces:**
- Produces: `interface VideoCaps { hevc: boolean; hevc10: boolean; hdrDisplay: boolean; phone: boolean }`
- Produces: `detectVideoCaps(env: VideoCapsEnv): Promise<VideoCaps>` with `interface VideoCapsEnv { isConfigSupported?: (c: { codec: string; codedWidth: number; codedHeight: number }) => Promise<{ supported?: boolean }>; matchMedia: (q: string) => { matches: boolean }; screen: { width: number; height: number }; memoryProfile: 'desktop' | 'constrained' }`, and `browserVideoCapsEnv(): VideoCapsEnv` (VideoDecoder.isConfigSupported when present, `window.matchMedia`, `window.screen`, `chooseMemoryProfile()` from `src/ui/memory-profile.ts`).
- Codec strings: HEVC Main `hvc1.1.6.L120.90`, Main10 `hvc1.2.4.L120.90`, at 1920×1080. A missing `isConfigSupported` or a rejection means false.
- Memoised: `videoCaps(): Promise<VideoCaps>` (one probe per page).

- [ ] **Step 1: Write the failing tests** — `detects HEVC and Main10 separately`, `no VideoDecoder means no HEVC`, `a rejected probe means unsupported`, `HDR display from dynamic-range: high`, `phone when constrained or when the shorter screen side is 900 or less` (cases: desktop 1920×1080 → false; desktop 2560×1600 → false; desktop 390×844 → true; constrained 2732×2048 → true).
- [ ] **Step 2: Run** `npx vitest run src/ui/video-caps.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `src/ui/video-caps.ts`.
- [ ] **Step 4: Run** the same — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(levels): probe HEVC, HEVC Main10, an HDR display and phone size for the level list"`

---

### Task 3: The level model

**Files:**
- Create: `src/ui/nas/level-model.ts`, `src/ui/nas/level-model.test.ts`

**Interfaces:**
- Consumes: `LevelInfo`, `LevelId`, `LevelAt` (Task 1); `bufferPlan`, `waitCopy`, `RATE_MARGIN` from `src/ui/nas/buffer-model.ts`.
- Produces:
  - `BUSY_COPY` and `BUSY_TRY_LATER_COPY` (the two strings in Global Constraints).
  - `ORIGINAL_ONLY: readonly LevelInfo[]` = `[{ level: 'original', label: 'Original', budgetMbps: 0, available: true }]` (what a NAS without levels means).
  - `levelRateMbps(l: LevelInfo, originalMbps: number): number` (Original → `originalMbps`, else `budgetMbps`).
  - `autoLevel(levels: readonly LevelInfo[], o: { connectionMbps: number; phone: boolean; originalMbps: number }): LevelId` (the Global Constraints rule; phone: `phone-720` when available, else the available level with the lowest rate).
  - `interface LevelRow { level: LevelId; label: string; available: boolean; note: string }` and `levelRows(levels, o: { durationS: number; originalBytes: number; connectionMbps: number; quotaBytes: number }): LevelRow[]`: for an available level, `note` is `plays now` when `bufferPlan` says play, else `about N minutes` from `waitCopy`'s minutes (a level's bytes are `budgetMbps × 1e6 / 8 × durationS`); for an unavailable one, `note` is the reason's copy: `unplayable` → `can't play in this browser`, `no-encoder` → `not on this NAS`, `no-hevc`/`no-hevc10` → `this device can't decode it`, `no-hdr-display` → `needs an HDR screen`, `busy` → `the NAS is busy`.
  - `busyMessage(levels): string | null` — `BUSY_TRY_LATER_COPY` when Original is unplayable and every re-encoded level is busy, `BUSY_COPY` when any re-encoded level is busy and Original plays, else null.
  - `levelAudio(audio: readonly { language: string }[], o: { psr1?: number; language: string }): number` — `psr1` when it names an entry; else the first entry whose language matches the browser language's first two letters (case-insensitive; disc languages are ISO 639-2, so map with the existing language helpers if one exists in `src/ui/`, else compare against a three-letter table for `en`/`ja`/`fr`/`de`/`es`/`it`/`zh`/`ko`); else 1.
  - `badgeText(l: LevelInfo): string | null` — null for Original, else `` `${l.label} · re-encoded on the NAS` ``.

- [ ] **Step 1: Write the failing tests** (exact cases):

```ts
const L = (level: LevelId, budgetMbps: number, available = true, reason?: LevelReason): LevelInfo => ({ level, label: level, budgetMbps, available, ...(reason ? { reason } : {}) });
const film = [L('original', 0), L('h264-1080', 10), L('hevc-1080', 7), L('phone-720', 4)];
it('a computer takes Original when it fits with the 1.1 margin', () => expect(autoLevel(film, { connectionMbps: 50, phone: false, originalMbps: 40 })).toBe('original'));
it('a computer takes the first level that fits, in the server order', () => expect(autoLevel(film, { connectionMbps: 17, phone: false, originalMbps: 40 })).toBe('h264-1080'));
it('a computer on a slow line takes the lowest rate when nothing fits', () => expect(autoLevel(film, { connectionMbps: 2, phone: false, originalMbps: 40 })).toBe('phone-720'));
it('a phone takes Phone even on a fast line', () => expect(autoLevel(film, { connectionMbps: 300, phone: true, originalMbps: 40 })).toBe('phone-720'));
it('an MPEG-2 disc never takes Original', () => expect(autoLevel([L('original', 0, false, 'unplayable'), L('h264-1080', 10)], { connectionMbps: 300, phone: false, originalMbps: 30 })).toBe('h264-1080'));
it('offers Original alone when the NAS has no levels', () => expect(autoLevel(ORIGINAL_ONLY, { connectionMbps: 2, phone: true, originalMbps: 40 })).toBe('original'));
it('rows say plays now or the wait, and why a level is unavailable', () => { /* 17 Mbps, 40 Mbps original over 2 h → original 'about N minutes', h264-1080 'plays now', hevc-1080 with reason no-hevc 'this device can't decode it' */ });
it('busy copy: Original fallback, or try later when Original cannot play', () => { /* both strings exactly */ });
it('audio: a saved PSR1 wins, then the browser language, then 1', () => { /* [{language:'jpn'},{language:'eng'}] with language 'en-US' → 2; psr1 1 → 1; 'de' → 1 */ });
it('badge names the level, and nothing for Original', () => expect(badgeText(L('h264-1080', 10))).toBe('h264-1080 · re-encoded on the NAS'));
```

- [ ] **Step 2: Run** `npx vitest run src/ui/nas/level-model.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `level-model.ts`.
- [ ] **Step 4: Run** the same — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(levels): the level model: auto choice, rows with waits and reasons, busy copy, audio number, badge"`

---

### Task 4: The engine's `setLevel`

**Files:**
- Modify: `src/engine/protocol.ts` (command `setLevel`, event `levelChanged`)
- Modify: `src/engine/player.ts` (`setLevel`; `bootDisc` ~1138 boots BD-J on `original`; `applyAudio` ~2386 guard)
- Modify: `src/player/player-controller.ts` (`setLevel(spec)`; reducer: `levelChanged` → `snapshot.levelSwitch`)
- Test: `src/engine/player.test.ts` (or the player test file holding `openRemote`/`selectAudio` cases; follow its fakes), `src/player/player-controller.test.ts`

**Interfaces:**
- Produces (protocol): command `{ type: 'setLevel'; disc: RemoteDiscSpec }` (same disc id, another version, never with a `fetchPort`: over WebRTC (`rtc://` base) the engine keeps reading through the open disc's port, which the UI keeps serving); event `{ type: 'levelChanged'; ok: true } | { type: 'levelChanged'; ok: false; message: string }`.
- Produces (controller): `setLevel(spec: RemoteDiscSpec): void`; `PlayerSnapshot.levelSwitch: 'idle' | 'switching' | { error: string }` (`switching` from `setLevel` until `levelChanged`, then `idle` or the error).
- Behaviour of `Player.setLevel(spec)`:
  1. Refuse with `levelChanged { ok: false, message: 'Another disc is open.' }` when `spec.manifest.discId` differs from the open remote disc's.
  2. Note the current playlist, time and paused state; stop the session's pipeline and the cache fill.
  3. Replace `remote`/`source` (`createByteSource(spec)`), the read-ahead cache (`openCache` with the new manifest: segment names carry file sizes, so old segments don't mix), `discSpec` (keep `original` for BD-J), and `disc` (`openDisc` + the clips the current model had loaded, from the new source).
  4. Give the new `DiscModel` to `PlayerBdjHost` (`deps.disc`) and to the HDMV `Navigator`, with no change to their state (registers, VM, BD-J worker untouched).
  5. Start the current playlist again **through the same path as a playlist start** (`playPlaylist` with the start time), so `chooseStreams`, `picture`, the decoder and the compositor are chosen on the new model; restore paused state.
  6. Emit `levelChanged { ok: true }`; on any failure in 3–5, emit `{ ok: false, message }` and leave the disc closed with the usual error event (the UI then offers the level list again; no silent fallback).
- `bootDisc`: boot the BD-J worker with `{ ...discSpec, manifest: discSpec.original ?? discSpec.manifest, query: undefined }`.
- `applyAudio(index)`: an index the playing playlist's STN doesn't have is ignored (log once), never an exception.

- [ ] **Step 1: Write the failing tests**

```ts
it('setLevel reads the new version and restarts the playlist at the current time', async () => {
  // open remote disc (fake transport recording file URLs), play 00001 to 8 s, setLevel(spec with query 'level=h264-1080&audio=1')
  expect(reads.at(-1)).toContain('level=h264-1080&audio=1');
  expect(events).toContainEqual({ type: 'levelChanged', ok: true });
  expect(lastPlaylistStart).toMatchObject({ playlistId: '00001', fromUs: expect.closeTo(8_000_000, -5) });
});
it('setLevel keeps a paused disc paused at its time', async () => { /* paused at 5 s → after setLevel engineState paused, clock 5 s */ });
it('setLevel on a no-picture playlist starts the picture on the new version', async () => {
  // original MPLS/CLPI say MPEG-2 (0x02), the level's say H.264 (0x1B): before → unsupported{noPicture}; after → decoder configured and noticeCleared
});
it('setLevel refuses another disc', async () => { expect(events).toContainEqual({ type: 'levelChanged', ok: false, message: 'Another disc is open.' }); });
it('BD-J boots on the original manifest without the level query', async () => { /* createBdjWorker fake sees manifest === original and no query */ });
it('ignores a PSR1 change to a track the level does not carry', async () => { /* level STN has 1 audio; selectAudio({index: 3}) or a PSR1 event → no throw, audioStream unchanged */ });
// player-controller.test.ts
it('levelSwitch goes switching, then idle or the error', () => { /* setLevel → 'switching'; levelChanged ok → 'idle'; ok false → { error } */ });
```

- [ ] **Step 2: Run** `npx vitest run src/engine/player.test.ts src/player/player-controller.test.ts -t "setLevel|BD-J boots on the original|PSR1 change|levelSwitch"` — Expected: FAIL.
- [ ] **Step 3: Implement** protocol, `Player.setLevel`, `bootDisc`, the `applyAudio` guard, controller method and reducer.
- [ ] **Step 4: Run** the engine and player suites: `npx vitest run src/engine src/player && npx tsc -b` — Expected: PASS (the BD-J trace and vm-trace suites in `tests/` unchanged: `npx vitest run tests/bdj tests/vm-trace`).
- [ ] **Step 5: Commit** — `git commit -m "feat(engine): setLevel swaps a NAS disc's version and restarts the playlist on it; BD-J keeps the original"`

---

### Task 5: The level session

**Files:**
- Create: `src/ui/nas/level-session.ts`, `src/ui/nas/level-session.test.ts`

**Interfaces:**
- Consumes: Task 1 (`NasClient.manifest/releaseViewing`, `NasBusyError`, `nasDiscSpec`), Task 3 (`LevelInfo`, `badgeText`), Task 4 (`controller.setLevel`, `snapshot.levelSwitch`).
- Produces: `levelSessionOf(nas: NasClient): LevelSession` (one per `NasClient`, a `WeakMap`, like `sessionCache` in `TitleLibrary.tsx`), and:

```ts
interface LevelState {
  readonly discId: string;
  readonly levels: readonly LevelInfo[];
  readonly at: LevelAt;
  /** The original version's audio streams of the playing playlist, for the Audio menu at a level (1-based numbers). */
  readonly originalAudio: readonly { number: number; language: string; label: string }[];
  readonly notice: string | null; // the last switch's busy or failure message
}
class LevelSession {
  get(): LevelState | null; subscribe(fn: () => void): () => void; // for useSyncExternalStore
  begin(s: { discId: string; levels: readonly LevelInfo[]; at: LevelAt; original: DiscManifest }): void; // after a pre-flight opens a disc
  switchTo(at: LevelAt, deps: { controller: PlayerController; base: string; token: string }): Promise<void>; // manifest at `at` (busy → notice, keep), controller.setLevel({ kind: 'remote', base, token, manifest, query: levelQuery(at), original }) with no fetch port, on levelChanged ok release the old lease
  end(): void; // the disc closed or another opened: releases the current lease (Original has none), clears state
}
```

- Releasing: `releaseViewing` for the previous `at` once after a successful switch (not for Original), and for the current `at` once on `end()`. `end()` is idempotent.
- Busy on switch: `notice = e.message` (the NAS's copy), `at` unchanged, no `setLevel`.

- [ ] **Step 1: Write the failing tests** — `switches by fetching the level's manifest then setLevel`, `a busy NAS keeps the current level and says why` (notice === BUSY_COPY from a NasBusyError), `releases the old lease after a switch and on close, once each` (DELETE for `h264-1080` after switching to `phone-720`; DELETE for `phone-720` on `end()`; a second `end()` sends nothing; Original never sends), `an audio switch at a level is a switch to the same level with that audio`.
- [ ] **Step 2: Run** `npx vitest run src/ui/nas/level-session.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `level-session.ts`.
- [ ] **Step 4: Run** the same — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(levels): the level session: the open disc's level, switches and leases"`

---

### Task 6: The pre-flight's level list

**Files:**
- Modify: `src/ui/nas/Preflight.tsx` (manifest/probe at ~149–162, the plan at ~213–218, `play` at ~257–298, the disabled `Lower quality (coming later)` button at ~415–419)
- Modify: `src/ui/styles.css` (the list)
- Test: E2E in Task 8 (there is no Preflight component test; the decisions live in Task 3's model)

**Interfaces:**
- Consumes: Tasks 1–3, 5. `videoCaps()` (Task 2) for the `levels` query; `levelAudio` (Task 3) with the resume place's `psr1` when resuming and `navigator.language`, from the original manifest's main/episode playlist STN audio list.
- Behaviour:
  - After the probe: `nas.levels(discId, { ...caps flags, audio })`; `null` → `ORIGINAL_ONLY`. Preselect `autoLevel(...)`.
  - When more than one level is listed, show `<fieldset data-testid="level-list">` with one radio per row (`data-testid="level-option"`, `data-level`, label `<label> · <note>`; unavailable rows disabled), and `busyMessage` above it when non-null (`data-testid="level-busy"`).
  - The buffer plan, the throughput line and the Wait/Play-now choice use the selected level's bytes (Original: as today; a level: `budgetMbps × 1e6 / 8 × durationS`).
  - Play/Wait/Play now: for a level, `nas.manifest(discId, at)` (a `NasBusyError` → show its message, keep the list, don't open), then `nasDiscSpec(..., { at, original })` and `openRemote` as today; then `levelSessionOf(nas).begin(...)`. Original: today's path exactly, and `begin` with `at.level = 'original'`.
  - The disabled `Lower quality (coming later)` button is removed (the list replaces it).
  - Resume (`ResumePrompt`) is unchanged: it plays at the selected level.

- [ ] **Step 1:** Implement the above in `Preflight.tsx` (and styles: one row per level, the note in the muted style).
- [ ] **Step 2: Run** `npx tsc -b && npx vitest run src/ui` — Expected: PASS.
- [ ] **Step 3: Commit** — `git commit -m "feat(levels): the pre-flight lists the levels with their waits and preselects the auto choice"`

---

### Task 7: Quality menu, Audio at a level, badge, places

**Files:**
- Create: `src/ui/QualityMenu.tsx`
- Modify: `src/ui/ControlBar.tsx` (~172–201: render `QualityMenu` beside `AudioMenu`), `src/ui/AudioMenu.tsx` (an optional `levelAudio` prop), `src/ui/PlayerScreen.tsx` (read the level session with `useSyncExternalStore`, pass props, show the badge and the session's notice beside `RelayBadge` at ~613–625, call `levelSessionOf(nas).end()` where the NAS disc stops: ~136–146)
- Modify: `src/ui/place-saver.ts` (at a level, the saved `psr1` is the level's `at.audio`, not the engine's 1)
- Test: `src/ui/place-saver.test.ts`, E2E in Task 8

**Interfaces:**
- Consumes: Task 5 (`LevelSession`, `LevelState`), Task 3 (`badgeText`, `levelRateMbps`).
- `QualityMenu` props: `{ state: LevelState; onPick: (level: LevelId) => void; onOpenChange: (open: boolean) => void }`; trigger `data-testid="quality-menu"`, items `menuitemradio` with `data-level`, label `<label>` and the rate (`1080p · 10 Mbps`; Original without a rate), unavailable items disabled with the reason note as `title`; hidden when fewer than two available levels. Same keyboard and outside-click behaviour as `AudioMenu` (copy its pattern).
- `AudioMenu`: when `levelAudio` is given (`{ tracks: LevelState['originalAudio']; current: number; onPick: (n: number) => void }`), it lists those tracks and calls `onPick` instead of `controller.selectAudio`.
- Badge: `<span data-testid="level-badge">` with `badgeText`; for a disc whose Original is `unplayable`, append ` (this disc's video can't play here as it is)`.
- While `snapshot.levelSwitch === 'switching'` show a notice `Switching quality…`; on `{ error }` show the error.

- [ ] **Step 1: Write the failing test** — `place-saver.test.ts`: `at a level, the saved PSR1 is the level's audio number` (engine snapshot audio index 1, level session at `{ level: 'phone-720', audio: 3 }` → saved `settings.psr1 === 3`).
- [ ] **Step 2: Run** `npx vitest run src/ui/place-saver.test.ts -t "level"` — Expected: FAIL.
- [ ] **Step 3: Implement** the saver change, `QualityMenu`, the Audio menu prop, the badge, the notices and `end()`.
- [ ] **Step 4: Run** `npx tsc -b && npx vitest run src/ui src/player` — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(levels): Quality menu, audio at a level, the level badge, and places keep the original audio number"`

---

### Task 8: End to end, CI and docs

**Files:**
- Modify: `tests/e2e/nas-server.ts:117-118` (`LEVELS_BACKEND: 'x264'`), `.github/workflows/ci.yml` (the `e2e` job installs ffmpeg as the `check` job does, line ~25)
- Modify: `tests/e2e/nas.spec.ts` (~288: the `Lower quality (coming later)` assertion becomes the level list's; new tests below)
- Modify: `CLAUDE.md` (quality levels paragraph: phase 2 in; the new test hooks), `docs/superpowers/specs/2026-10-19-lower-quality-design.md` (status line), `docs/known-issues.md` (a disc program's own audio choice at a level is ignored; the auto rule's "phone" is a size, not a device)

**Tests (new, in `nas.spec.ts`, every desktop project):**
- `plays a disc at a re-encoded level picked in the pre-flight, seeks, and switches to Original`: open disc1's episode; `level-list` shows; pick `[data-testid=level-option][data-level=h264-1080]`; Play; `framesPresented > 30`; `level-badge` text `1080p · re-encoded on the NAS`; seek (keyboard ArrowRight); frames advance; open `quality-menu`, pick Original; `levelSwitch` back to idle (badge gone), frames advance past the switch time.
- `an MPEG-2 disc plays with a picture at a re-encoded level`: open `disc-mpeg2-menu`'s feature; Original's row is disabled with `can't play in this browser`; a re-encoded level is preselected; Play; `framesPresented > 30`; no notice with code `no-picture`.
- The existing slow-connection test (~268): instead of the disabled button, the level list preselects a re-encoded level and its note says `plays now`.

- [ ] **Step 1:** Switch the stand-in to x264 and add ffmpeg to the CI `e2e` job.
- [ ] **Step 2:** Write the tests above and update the old assertion.
- [ ] **Step 3: Run** `npm run build && npx playwright test tests/e2e/nas.spec.ts tests/e2e/mobile-*.spec.ts` (one checkout's NAS E2E at a time) — Expected: all pass, with the previous count plus the new tests.
- [ ] **Step 4:** Update CLAUDE.md, the spec's status line and `docs/known-issues.md`.
- [ ] **Step 5: Commit** — `git commit -m "test(levels): E2E for a re-encoded level, a switch and an MPEG-2 disc; CI encodes with x264; docs"`

---

### Task 9: "Encoding now" on the owner's admin screen

Spec §6.4: "The owner's admin screen shows what's encoding for whom." Phase 1 has no route for it.

**Files:**
- Modify: `server/src/levels/capacity.ts` (`list()`), `server/src/levels/level-service.ts` (`encodingNow()`), `server/src/routes/admin.ts` (`GET admin/encoding`)
- Modify: `src/engine/disc/nas-api.ts` (`EncodingNow`), `src/ui/nas/nas-client.ts` (`admin.encodingNow()`), `src/ui/nas/AdminScreen.tsx` (a section)
- Test: `server/src/levels/capacity.test.ts`, `server/src/routes/admin.test.ts`, `src/ui/nas/nas-client.test.ts`

**Interfaces:**
- `Capacity.list(): readonly { viewingId: string; codec: EncoderCodec; needFps: number; idleMs: number }[]`
- `LevelService.encodingNow(): readonly { deviceId: string; discId: string; level: LevelId; audio: number; codec: EncoderCodec; gpuShare: number }[]` (the viewing id's parts as `LevelService` builds them; `gpuShare` = `needFps` ÷ its codec's budget, 0–1)
- `GET admin/encoding` (owner only, like the other admin routes) → `{ encoding: EncodingNow[] }` with `interface EncodingNow { personName: string; deviceName: string; discName: string; level: LevelId; label: string; gpuPercent: number }` (`discName`: the catalogue's display name, else the folder's last segment; `gpuPercent` rounded); 404 when there is no backend.
- AdminScreen: an "Encoding now" section (`data-testid="encoding-now"`), one line per viewing: `<person> · <device> — <disc>, <label> (<gpuPercent>% of the GPU)`, or `Nothing is being re-encoded.`; refreshed when the screen opens and every 10 s while it shows; hidden on a 404.

- [ ] **Step 1: Write the failing tests** — `capacity.test.ts`: `list shows each lease with its idle time` (two leases, clock advanced 30 s → idleMs 30 000); `admin.test.ts`: `GET admin/encoding names the person, device, disc and level of each viewing, owners only` (a guest token → 403/404 as the other admin routes answer; an owner sees one entry after a manifest at `h264-1080`); `nas-client.test.ts`: `admin.encodingNow reads admin/encoding and answers null on 404`.
- [ ] **Step 2: Run** `npx vitest run server/src/levels/capacity.test.ts server/src/routes/admin.test.ts src/ui/nas/nas-client.test.ts -t "encoding|list shows"` — Expected: FAIL.
- [ ] **Step 3: Implement** the four pieces and the AdminScreen section.
- [ ] **Step 4: Run** `npx vitest run server src/ui/nas && npx tsc -b` — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(levels): the owner's admin screen shows what the NAS is re-encoding for whom"`

---

## After the plan (not tasks)

- Deploy: the app goes out with CI; Task 9 adds a server route, so the NAS is redeployed too (`npm run server:deploy`), with the user's go-ahead.
- Device run (spec §8): the iPhone on mobile data opens a film, auto picks Phone, plays with no wait, seeks, switches to 1080p; an MPEG-2 film plays. Done by hand with the user, after merge.
