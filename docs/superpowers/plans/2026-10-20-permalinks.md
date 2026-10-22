# Permalinks (piece 1 of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The address bar follows every NAS library screen and NAS playback with stable-id paths under `/nas/`, browser Back and Forward move between screens, and a link opened on an unpaired device shows a not-found screen asking for an invite.

**Architecture:** A pure route module parses and formats `/nas/…` URLs; a small history store (`NasHistory`, over an injectable `HistoryLike`) is the single place that pushes, replaces and listens for `popstate`, and the landing screen, title library and folder browser render from its current route instead of their own navigation state. Disc links use a `discKey` (`f.<content fingerprint>` or `d.<disc id>`) computed by one shared helper; the NAS gets one new route that resolves a key to a disc. Playback keeps a `/nas/play/<discKey>?pl=&t=` path current; opening one goes through the existing pre-flight (a tap is needed to start audio), then plays the playlist and seeks to `t`.

**Tech Stack:** TypeScript (strict), React 19 with `useSyncExternalStore`, Vitest, Playwright, the NAS server on plain Node.

**Spec:** `docs/superpowers/specs/2026-10-20-permalinks-resume-design.md` (§5 is this plan; §6–7 are pieces 2 and 3, not built here).

## Global Constraints

- Paths are under `/nas/`, use stable ids, never folder names for titles, seasons or discs (spec §5.1).
- `titleId` is the catalogue's title id; `seasonKey` is the part of the catalogue's season id after `#` (`s2`, `discs`, `season`); the title's own extras are `/nas/title/<titleId>/extras` (spec §5.1).
- `discKey` is `f.<fingerprint>` when the disc has a content fingerprint (TheDiscDB ContentHash, `src/engine/disc/content-hash.ts`), else `d.<discId>` (spec §5.1).
- While a NAS disc plays, the path is updated with `history.replaceState` at most every 5 s and on pause or seek; opening a screen uses `pushState` (spec §5.1).
- `/` stays the landing page; `?pair=` links keep working and are still removed after reading (spec §5.1).
- A `/nas/play/…` link uses the receiver's own settings and shows no resume prompt (spec §5.2; there is no resume yet, so: no prompt).
- Not-found copy, exactly: "This link is for a NAS this device isn't paired with. Ask its owner to send you an invite." (spec §5.2), shown for: not paired, a key or title the NAS doesn't have, and a guest behind the closed title gate.
- Links are NAS-only: a disc opened from a local folder or the disc server leaves the address bar alone (spec §3).
- `src/engine/` must not import from `src/ui/` or React; the NAS server has no native dependencies (CLAUDE.md).
- The repo is public: tests use the made-up fixture titles (Starfall Wanderer, Moonlit Harbor, Lantern Parade Live 2024).
- Run the NAS E2E by full path: `npx playwright test tests/e2e/nas.spec.ts`.

## Review Focus

1. **Ids with reserved characters** (`anilist:123`, own-title ids, folder names with `/`, `%`, `#`, spaces, Japanese) must round-trip through `nasRoutePath` → `parseNasRoute` unchanged. Pinned in Task 3.
2. **Reloading during playback** at `/nas/play/…` lands on the pre-flight for that disc with the playlist and time kept, not on a silent failed autoplay. Pinned in Task 7 (E2E).
3. **Browser Back while a NAS disc plays** closes the disc and returns to the screen it was opened from; Back on a link opened cold (no earlier app entry) returns to the title or library, never off the app with the disc still open. Pinned in Task 7.
4. **A bad `t` or `pl`** (negative, non-numeric, past the playlist's end, a playlist the disc lacks) opens the disc without seeking, with the existing "episode isn't on this disc" notice for a missing playlist. Pinned in Tasks 3 and 7.
5. **The device is unpaired while on a `/nas` path** (revoked mid-session): the address bar goes back to `/` with the existing unpaired message, and a reload doesn't show a stale screen. Pinned in Task 6.

---

### Task 1: Shared disc key

**Files:**
- Create: `src/engine/disc/disc-key.ts`
- Test: `src/engine/disc/disc-key.test.ts`
- Modify: `server/src/titles/evidence.ts:93-96` (use `streamsOf`)

**Interfaces:**
- Produces:
  - `streamsOf(files: readonly { path: string; size: number }[]): { name: string; size: number }[]`: the `BDMV/STREAM/*.M2TS` files (paths as the manifest gives them, upper-case), named by file name.
  - `discKeyOf(discId: string, files: readonly { path: string; size: number }[]): string`: `f.<contentHash(streamsOf(files))>` or `d.<discId>` when the hash is null.
  - `type ParsedDiscKey = { kind: 'fingerprint'; fingerprint: string } | { kind: 'disc'; discId: string }`
  - `parseDiscKey(key: string): ParsedDiscKey | null`: null for anything not `f.<32 upper-hex>` or `d.<16 lower-hex>`.

- [ ] **Step 1: Write the failing tests** in `disc-key.test.ts`:
  - `discKeyOf('0123456789abcdef', files)` with two `BDMV/STREAM/0000x.M2TS` entries equals `` `f.${contentHash([{name:'00001.M2TS',size},{name:'00002.M2TS',size}])}` ``, and ignores `BDMV/PLAYLIST/…` and `BDMV/STREAM/SSIF/…` entries.
  - With no `.M2TS` file it returns `'d.0123456789abcdef'`.
  - `parseDiscKey` round-trips both forms, and returns null for `''`, `'x.abc'`, `'f.xyz'`, `'d.ABC'`, `'f.'`.
- [ ] **Step 2: Run** `npx vitest run src/engine/disc/disc-key.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the three functions in `disc-key.ts`, with `streamsOf` using evidence.ts's regex `/^BDMV\/STREAM\/([^/]+\.M2TS)$/`; replace evidence.ts's inline `streams` with `streamsOf(files)` so the server and the app can never disagree.
- [ ] **Step 4: Run** `npx vitest run src/engine/disc/disc-key.test.ts server/src/titles` . Expected: PASS (evidence tests unchanged).
- [ ] **Step 5: Commit** `feat(disc): one disc key for links, from the content fingerprint`.

### Task 2: Resolve a disc key on the NAS

**Files:**
- Modify: `server/src/routes/discs.ts` (new route before `ROUTE`)
- Modify: `server/src/manifest.test.ts` (`describe('disc routes')`)
- Modify: `src/ui/nas/nas-client.ts`, `src/ui/nas/nas-client.test.ts`
- Modify: `server/src/rtc/dispatch.ts` only if it allowlists API paths (check; the route must work over WebRTC too)

**Interfaces:**
- Consumes: `parseDiscKey` (Task 1); `Library.disc(id)`, `Library.evidence()`.
- Produces:
  - `GET /api/discs/resolve/<discKey>` → `200 { disc: DiscEntry }` or `404 { error: 'not-found' }` (token required, like every disc route). A fingerprint matching several discs answers the one with the smallest `path` (byte order), so a link always opens the same copy.
  - `NasClient.resolveDisc(key: string): Promise<DiscEntry | null>`: null on 404; other errors throw as `json()` does.

- [ ] **Step 1: Write the failing tests:** in `manifest.test.ts`, `it('resolves a disc key to the listed disc, fingerprint first')`: a `d.` key of a listed disc → 200 with that `DiscEntry`; the `f.` key of two copies of one synthetic disc (copy the fixture into two folders) → the copy with the smaller path; an unknown `d.`/`f.` key and a malformed key → 404 `{ error: 'not-found' }`. In `nas-client.test.ts`, `it('resolves a disc key, null when the NAS has none')`.
- [ ] **Step 2: Run** `npx vitest run server/src/manifest.test.ts src/ui/nas/nas-client.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the route (match `/^\/api\/discs\/resolve\/([^/]+)$/` before `ROUTE`, GET only) and `resolveDisc`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): resolve a disc link key to a disc`.

### Task 3: Route parsing and formatting

**Files:**
- Create: `src/ui/nas/nas-route.ts`, `src/ui/nas/nas-route.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type NasRoute =
    | { kind: 'library'; shelf: TitleKind | null; q: string }
    | { kind: 'title'; titleId: string }
    | { kind: 'season'; titleId: string; seasonKey: string }
    | { kind: 'extras'; titleId: string }
    | { kind: 'folders'; path: string }          // '' is the top
    | { kind: 'unsorted' } | { kind: 'hidden' } | { kind: 'settings' }
    | { kind: 'play'; discKey: string; playlistId: string | null; timeS: number | null };
  export function parseNasRoute(url: URL): NasRoute | null;   // null: not under /nas
  export function nasRoutePath(route: NasRoute): string;      // path + search, no origin
  export function seasonKeyOf(seasonId: string): string;      // text after the first '#'
  export function seasonIdOf(titleId: string, seasonKey: string): string; // `${titleId}#${seasonKey}`
  ```
  Paths: `/nas`, `/nas?shelf=movie`, `/nas?q=…`, `/nas/title/<id>`, `/nas/title/<id>/season/<key>`, `/nas/title/<id>/extras`, `/nas/folders/<seg>/<seg>`, `/nas/unsorted`, `/nas/hidden`, `/nas/settings`, `/nas/play/<discKey>?pl=<id>&t=<s>`. Each id or folder segment is one `encodeURIComponent` segment; `t` is whole seconds (`Math.floor`).

- [ ] **Step 1: Write the failing tests:** a round-trip table over every variant, including `titleId: 'anilist:21'`, an own-title id, `seasonKey: 'discs'`, folder path `'syn/Anime/Starfall Wanderer (星降りの旅人)/Vol.1 #2 100%'`, and `play` with and without `pl`/`t`; `parseNasRoute` returns `{ kind: 'library', shelf: null, q: '' }` for `/nas` and `/nas/`; null for `/`, `/nasx`, `/probe.html`; an unknown shelf → `shelf: null`; `/nas/title/x/season` (missing key) and `/nas/unknown` → `{ kind: 'library', shelf: null, q: '' }`; `t=-3`, `t=abc`, `t=1e99` → `timeS: null`; `t=12.9` → `12`; `seasonKeyOf('anilist:21#s2') === 's2'`, `seasonIdOf('anilist:21','s2') === 'anilist:21#s2'`.
- [ ] **Step 2: Run** `npx vitest run src/ui/nas/nas-route.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both functions with `URL`/`URLSearchParams` (no regex over the raw path; split `url.pathname` on `/` and `decodeURIComponent` each segment, treating a malformed escape as an unknown path).
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): parse and format NAS paths`.

### Task 4: The history store

**Files:**
- Create: `src/ui/nas/nas-history.ts`, `src/ui/nas/nas-history.test.ts`

**Interfaces:**
- Consumes: `parseNasRoute`, `nasRoutePath` (Task 3).
- Produces:
  ```ts
  export interface HistoryLike {
    readonly location: { readonly href: string };
    readonly history: { readonly state: unknown; pushState(s: unknown, u: '', url: string): void; replaceState(s: unknown, u: '', url: string): void; back(): void };
    addEventListener(type: 'popstate', l: () => void): void;
    removeEventListener(type: 'popstate', l: () => void): void;
  }
  export class NasHistory {
    constructor(win: HistoryLike);
    route(): NasRoute | null;                 // parsed from the current location
    /** How many app entries are behind this one (0 for a cold load or a link); kept in history.state as { nasDepth }. */
    depth(): number;
    push(route: NasRoute | null): void;       // null navigates to '/'
    replace(route: NasRoute | null): void;
    /** history.back() when depth() > 0, else replace(fallback). */
    back(fallback: NasRoute | null): void;
    /** The last navigation's direction, for focus: 'push' | 'pop' | 'replace' | 'load'. */
    lastMove(): 'push' | 'pop' | 'replace' | 'load';
    subscribe: (listener: () => void) => () => void;  // fires on push, replace and popstate
    getSnapshot: () => string;                         // location.href, for useSyncExternalStore
  }
  export function useNasRoute(h: NasHistory): NasRoute | null;
  export function getNasHistory(): NasHistory;         // the shared instance over window
  ```
  `push`/`replace` that would not change the URL do nothing (no duplicate entries). `replace` keeps the current `nasDepth`; `push` stores `depth() + 1`. Other keys in `history.state` are preserved.

- [ ] **Step 1: Write the failing tests** with a fake `HistoryLike` (an array of entries and an index): push increments depth and notifies; replace keeps depth; a fake popstate notifies and `lastMove()` is `'pop'`; `back(fallback)` at depth 0 replaces to the fallback's path, at depth 1 calls `history.back()`; pushing the current route adds no entry; `push(null)` goes to `/`.
- [ ] **Step 2: Run** `npx vitest run src/ui/nas/nas-history.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `NasHistory`, `useNasRoute` (`useSyncExternalStore(h.subscribe, h.getSnapshot)` then `h.route()`), and `getNasHistory()`.
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): a history store for NAS paths`.

### Task 5: Deep paths load the app everywhere

**Files:**
- Modify: `tools/disc-server/server.ts` (`serveApp`, ~line 374)
- Test: `tools/disc-server/server.test.ts`

**Interfaces:** none new.

- [ ] **Step 1: Write the failing test** `it('answers a deep app path with index.html')`: `GET /nas/title/anilist%3A21` with the token returns 200, `index.html`'s body and the COOP/COEP headers; `GET /nas/missing.js` (a path with an extension that is not a file) still returns 404.
- [ ] **Step 2: Run** `npx vitest run tools/disc-server/server.test.ts`. Expected: FAIL (404).
- [ ] **Step 3: Implement:** in `serveApp`, when the path is not a file and its last segment has no extension, send `index.html` instead.
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Verify the other hosts by reading, and note it in the commit:** Vite dev and preview serve `index.html` for deep paths (`appType` is the default `spa` in `vite.config.ts`); Cloudflare Pages does while `dist/` has no top-level `404.html` (`ls dist/404.html` must fail after `npm run build`); the service worker's `NavigationRoute` in `src/sw.ts` already answers every navigation except its denylist with the network or the cached shell. Task 7's E2E reloads on a deep path under preview.
- [ ] **Step 6: Commit** `fix(disc-server): deep app paths load the player`.

### Task 6: Library screens follow the address bar

**Files:**
- Modify: `src/ui/LandingScreen.tsx` (the `nasView` state and `setBrowsing`, `closeNas`, `showFolders`, `onUnpaired`)
- Modify: `src/ui/nas/TitleLibrary.tsx` (replace `stack`, `seasonId`, `ownerScreen`, `settings`, `picked`, `query` and `selected` with the route)
- Modify: `src/ui/nas/LibraryScreen.tsx` (folder `path` and `selected` from the route; `folderMemory` only seeds "Browse by folder instead")
- Modify: `src/ui/App.tsx` (create `getNasHistory()` next to the controller and pass it down)
- Test: `tests/e2e/nas.spec.ts`

**Interfaces:**
- Consumes: `NasHistory`, `useNasRoute`, `seasonKeyOf`, `seasonIdOf` (Tasks 3–4).
- Produces: `LandingScreen`, `TitleLibrary` and `LibraryScreen` take `history: NasHistory`. Every in-app navigation is a `history.push(route)`; every in-app Back button is `history.back(parentRoute)`, where the parent of a season is its title, of a title the library, of hidden the unsorted screen, of unsorted/settings/folders/play the library. Typing in search is `history.replace({ kind: 'library', shelf: null, q })`; picking a shelf is a push.

Behaviour to keep (existing NAS E2E tests must pass unchanged):
- The landing screen opens the NAS view when the route is non-null: `folders` → folder browser; anything else → `me()` first, then the title library (or, for a guest with the gate closed, the folder browser for `library` routes and the not-found screen of Task 8 for `title`/`season`/`extras` routes).
- Focus rules (`forward`/`backward` in `TitleLibrary`): a push focuses the new heading; a pop (`lastMove() === 'pop'`) focuses the opener, looked up with the same selectors as today.
- An owner's title that answers 404 after "file differently" goes back (`history.back(library)`), as today.
- A non-owner on `unsorted`, `hidden` or `settings` is replaced to the library.
- `onUnpaired`: `history.replace(null)` before the existing message and pairing reload.

- [ ] **Step 1: Write the failing E2E tests** in `nas.spec.ts` (each pairs as the owner with the existing `openTitles` helper):
  - `test('library screens are in the address bar, and Back and Forward move between them')`: open Starfall Wanderer → URL path is `/nas/title/<id>`; open its season → `/nas/title/<id>/season/s1`; `page.goBack()` shows the series screen and focuses its season row; `page.goForward()` shows the season again; pick the Movies shelf → `/nas?shelf=movie`.
  - `test('a library path opens straight onto its screen after a reload')`: from the season screen, `page.reload()` shows the season screen (heading "Season 1") without going through the library.
  - `test('the folder browser has its folder in the address bar')`: open `syn` → path `/nas/folders/syn`; reload shows the same folder.
  - Review Focus 5, `test('a device unpaired while on a NAS path goes back to the landing page')`: revoke the device through the owner API (as the existing revoke test does), click a title → URL path is `/`, the unpaired message shows; reload stays on `/`.
- [ ] **Step 2: Run** `npx playwright test tests/e2e/nas.spec.ts --project=chromium -g "address bar|after a reload|unpaired while"`. Expected: FAIL.
- [ ] **Step 3: Implement** the route-driven screens as described.
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run src/ui && npx playwright test tests/e2e/nas.spec.ts --project=chromium`. Expected: all PASS, including every existing NAS test.
- [ ] **Step 5: Commit** `feat(ui): the NAS library screens live in the address bar`.

### Task 7: Play links

**Files:**
- Modify: `src/ui/nas/play-once-open.ts`, `src/ui/nas/play-once-open.test.ts`
- Modify: `src/ui/nas/Preflight.tsx` (prop `startTimeS`, replace the route's `d.` key with the `f.` key once the manifest is in, launch through the route)
- Create: `src/ui/nas/playing-route.ts`, `src/ui/nas/playing-route.test.ts`
- Modify: `src/ui/PlayerScreen.tsx` (keep the play path current; close on Back), `src/ui/App.tsx` (pass `history`)
- Modify: `src/ui/LandingScreen.tsx` (a `play` route resolves its key and shows the pre-flight)
- Test: `tests/e2e/nas.spec.ts`

**Interfaces:**
- Consumes: `discKeyOf` (Task 1), `NasClient.resolveDisc` (Task 2), `NasHistory` (Task 4).
- Produces:
  - `playOnceOpen(controller: OpeningController, playlistId: string, startUs?: number): () => void`. `OpeningController` gains `seek(timeUs: number): void` and the snapshot fields `currentPlaylistId: string | null` and `durationUs: number`. With `startUs`, after `playPlaylist` it waits (same scoping as today) for `currentPlaylistId === playlistId && durationUs > 0`, then seeks when `startUs < durationUs`, else leaves it at 0.
  - `PlayingRoute` in `playing-route.ts`: `class PlayingRoute { constructor(h: NasHistory, nowMs: () => number); start(discKey: string): void; update(s: { currentPlaylistId: string | null; timeUs: number; engineState: string }): void; stop(): void }`. `start` is called by the pre-flight at launch; `update` (called by `PlayerScreen` on every snapshot) replaces the route with `{ kind: 'play', discKey, playlistId, timeS: floor(timeUs / 1e6) }` when at least 5000 ms have passed since its last replace, or at once when `engineState` changed to `'paused'` or the time jumped by more than 2 s from what it would be (a seek); it does nothing until `start` and after `stop`. A local or disc-server disc never calls `start`, so its playback leaves the address bar alone.
  - The pre-flight's launch pushes `{ kind: 'play', discKey: <d. or f. key>, playlistId, timeS: null }` when it isn't already on that route (from a title or folder), so Back returns to the screen it came from.
  - Back during NAS playback (a `popstate` whose route is not `play`): `PlayerScreen` calls `controller.closeDisc()` and `PlayingRoute.stop()`; the landing screen then renders the route Back landed on. In-app close (the player's existing close or disc-end path back to the landing screen) calls `history.back(library)` instead.

- [ ] **Step 1: Write the failing unit tests:**
  - `play-once-open.test.ts`: `it('seeks to the start time once the playlist is playing')` (fake controller emits `playlists`, then `currentPlaylistId` with `durationUs: 120e6`; expect `seek(30e6)` once); `it('does not seek past the end')` (`startUs: 200e6` → no seek); `it('does not seek when another disc opened meanwhile')`.
  - `playing-route.test.ts`: replaces at most every 5 s while playing; replaces at once on pause and on a 10 s jump; nothing before `start` or after `stop`; `timeS` is floored.
- [ ] **Step 2: Run** `npx vitest run src/ui/nas/play-once-open.test.ts src/ui/nas/playing-route.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both modules.
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Write the failing E2E tests** in `nas.spec.ts`:
  - `test('playing a NAS episode keeps a play link in the address bar')`: play Starfall Wanderer's episode 1 from its season; after 6 s of playback the path matches `^/nas/play/f\.[0-9A-F]{32}$` with `pl=<episode playlist>` and `t` ≥ 5.
  - Review Focus 2, `test('a play link opens the pre-flight, then plays from its time')`: `page.goto('/nas/play/<key>?pl=<id>&t=3')` → the pre-flight shows the disc's name; click Play → telemetry `clockUs` ≥ 3e6 within 5 s of `playing`; reload during playback → the pre-flight again with the same `pl` and a `t` near the last.
  - Review Focus 3, `test('Back during NAS playback closes the disc and returns to the season')`: from the season, play, `page.goBack()` → the season screen, no player; then a cold `page.goto` of a play link, Play, then the player's close → the library, still in the app.
  - Review Focus 4, `test('a play link with a bad time or playlist opens the disc without seeking')`: `t=-5` and `t=99999` play from 0; `pl=99999` shows the existing "This episode isn't on this disc; it opened normally." notice.
- [ ] **Step 6: Run** `npx playwright test tests/e2e/nas.spec.ts --project=chromium -g "play link|Back during"`. Expected: FAIL.
- [ ] **Step 7: Implement** the pre-flight, landing and player screen changes.
- [ ] **Step 8: Run** `npm run typecheck && npx vitest run src/ui && npx playwright test tests/e2e/nas.spec.ts --project=chromium && npx playwright test tests/e2e/nas.spec.ts --project=firefox`. Expected: PASS.
- [ ] **Step 9: Commit** `feat(ui): play links for NAS discs, kept current while playing`.

### Task 8: The not-found screen, and docs

**Files:**
- Create: `src/ui/nas/NasNotFound.tsx`
- Modify: `src/ui/LandingScreen.tsx` (render it), `src/ui/styles.css` (one rule block in the existing dark style)
- Modify: `CLAUDE.md` (one sentence under the main-thread architecture: NAS paths, `nas-route.ts`, `NasHistory`, `disc-key.ts`, the resolve route)
- Test: `tests/e2e/nas.spec.ts`

**Interfaces:**
- Consumes: the routes above.
- Produces: `NasNotFound({ onPair }: { onPair: () => void })`, `data-testid="nas-not-found"`, the Global Constraints copy, and a "Pair with a NAS" button that does `history.replace(null)` and opens the pair screen.

Shown when the route is non-null and: the device isn't paired; `resolveDisc` returns null; the title detail answers 404 at `depth() === 0` (a link, not an in-app step); or a guest with the gate closed opens a `title`, `season` or `extras` route.

- [ ] **Step 1: Write the failing E2E tests:**
  - `test('a NAS link on an unpaired device asks for an invite')`: fresh context, `page.goto('/nas/title/anilist%3A1')` → `nas-not-found` with the exact copy; the button shows the pair screen at `/`.
  - `test('a link to something the NAS does not have shows the same screen')`: paired, `goto('/nas/play/d.0000000000000000')` and `goto('/nas/title/anilist%3A999999999')` → `nas-not-found`.
  - `test('a guest behind the closed title gate gets not-found for a title link')`: with `setGate('owners')`, a guest device opening a title link → `nas-not-found`; `/nas` → the folder browser, as today.
- [ ] **Step 2: Run** `npx playwright test tests/e2e/nas.spec.ts --project=chromium -g "not-found|asks for an invite|does not have"`. Expected: FAIL.
- [ ] **Step 3: Implement** the screen and the four cases; add the CLAUDE.md sentence.
- [ ] **Step 4: Run** `npm run typecheck && npm test && npx playwright test tests/e2e/nas.spec.ts && npx playwright test --project=mobile-chromium`. Expected: PASS (the three player tests that already fail on `main`, "pauses and resumes", "holding and slowly dragging the seek bar…" and "Enter after clicking the Pop-up button…", are not in these runs).
- [ ] **Step 5: Commit** `feat(ui): a not-found screen for NAS links this device can't open`.
