# NAS subtitle store (piece 3 of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Owners upload SRT/ASS subtitles with their fonts to the NAS, attached to an episode or to a disc and chapter, with a language, a name and a default offset; everyone paired sees language tags on episodes, picks a stored subtitle in the player's Subtitles menu, and their own offset adjustment is saved with their place and restored on resume.

**Architecture:** A `SubtitleStore` on the NAS keeps each upload under `/data/subtitles/<id>/` (meta.json, the subtitle file, fonts), and `routes/subtitles.ts` serves it: reads under the title gate, writes for owners only, bodies streamed raw (one request per file, so nothing nears the WebRTC route's 16 MB queue). An episode attachment is fixed at upload to the episode's disc key and playlist; the list answers whether each attachment still resolves. In the app, a pure `subtitle-model.ts` holds the rules; the owner's upload sheet sits on the season and movie screens; the player's Subtitles menu gains "From the NAS"; a stored pick is loaded through the existing text-subtitle path and remembered in the place by a new `subtitleId`.

**Tech Stack:** TypeScript (strict), React 19, Vitest, Playwright, the NAS server on plain Node.

**Spec:** `docs/superpowers/specs/2026-10-20-permalinks-resume-design.md` §7 (this plan), with §6.1 (places), §6.6 (Up next carries stored subtitles by language).

## Global Constraints

- Only owners upload, edit and delete; everyone paired lists, downloads and uses (spec §7, user). Reads follow the title gate: when `TITLE_LIBRARY`/the owner's gate is `owners`, a guest gets 404 for subtitle reads, as title routes do (spec §7.1).
- Stored under `/data/subtitles/<subtitleId>/`: `meta.json`, the subtitle file, its fonts. The library mounts stay read-only; nothing is written outside `/data` (CLAUDE.md).
- Limits (spec §7.1, my call): 5 MB per subtitle file, 50 MB of fonts per upload, 2 GB in all; enforced as the body streams in.
- Attachment (spec §7.1): an **episode** — fixed at upload to `{ discKey, playlistId }` from the catalogue's `EpisodeRef`, with `titleId`, `seasonId`, `episode` kept for display; or a **disc and chapter** — `{ discKey, playlistId, chapter }` (0-based chapter index; the file is placed at that chapter's start). An attachment whose disc or playlist no longer resolves is listed to owners as not attached (`attached: false`) and hidden from everyone else; owners can re-attach it.
- Meta: `{ id, name, language (BCP 47), offsetMs (default offset), fileName, fileSize, fonts: { name, size }[], attachment, uploaderPersonId, uploadedAt }`.
- The viewer's offset adjustment is saved in their place, not on the upload (spec §7.2, user); the upload's default offset applies first.
- Up next carries the stored subtitle of the next episode in the same language when one exists (spec §6.6).
- Local, not-uploaded SRT/ASS files keep working as today (spec §7.2).
- The NAS server has no native dependencies; `src/engine/` never imports `src/ui/`; the repo is public (made-up names in tests). Run the NAS E2E by full path with `E2E_PORT=<free port>`; ports 4191/4192 and UDP 47990 are shared with other checkouts.

## Review Focus

1. **A guest on a closed gate, or a non-owner, tries to write** (upload, patch, delete): 403 for a paired non-owner, 404 for reads under the closed gate; nothing on disk changes. Pinned in Task 2.
2. **An upload that dies halfway** (a 50 MB font over a dropped connection, a browser closed mid-upload): no half-written upload is listed; a meta without its subtitle file is never offered to viewers. Pinned in Tasks 1–2.
3. **A font or subtitle name with path characters** (`../x.ttf`, `a/b.ass`, NUL, 300-character names): refused (400); stored names never escape the upload's folder. Pinned in Task 1.
4. **A stored subtitle picked while local files are loaded, or two files with the same name**: picking replaces the text set (as a new local pick does), and the place records which file came from the NAS. Pinned in Task 5.
5. **The NAS unreachable when resuming a place with a stored subtitle**: playback starts anyway, without that subtitle and without an error dialog; the place keeps its `subtitleId`. Pinned in Task 6.

---

### Task 1: The NAS subtitle store

**Files:**
- Create: `server/src/subtitle-store.ts`, `server/src/subtitle-store.test.ts`
- Modify: `src/engine/disc/nas-api.ts` (shared types)

**Interfaces:**
- Produces (nas-api.ts, no runtime code):
  ```ts
  export type SubtitleAttachment =
    | { readonly kind: 'episode'; readonly discKey: string; readonly playlistId: string; readonly titleId: string; readonly seasonId: string; readonly episode: number }
    | { readonly kind: 'chapter'; readonly discKey: string; readonly playlistId: string; readonly chapter: number };
  export interface StoredSubtitle {
    readonly id: string; readonly name: string; readonly language: string; readonly offsetMs: number;
    readonly fileName: string; readonly fileSize: number; readonly fonts: readonly { readonly name: string; readonly size: number }[];
    readonly attachment: SubtitleAttachment; readonly uploaderPersonId: string; readonly uploadedAt: number;
    /** Set by the route: false when the attachment's disc or playlist no longer resolves (owners only see these). */
    readonly attached?: boolean;
  }
  ```
- `SubtitleStore(dataDir: string, opts?: { maxTotalBytes?: number; now?: () => number })` (2 GB default):
  - `create(meta: Omit<StoredSubtitle, 'id' | 'fileName' | 'fileSize' | 'fonts' | 'uploadedAt' | 'attached'>): StoredSubtitle` — new random id (16 lowercase hex), meta written with no file yet (`fileSize: 0`, not listed until a file is written).
  - `writeFile(id, fileName, body: AsyncIterable<Buffer>, limit = 5 MiB): Promise<StoredSubtitle>` — streams to a temp file, renames into place; replaces an earlier file.
  - `writeFont(id, fontName, body, limit): Promise<StoredSubtitle>` — the limit is 50 MiB minus the upload's other fonts; same name replaces.
  - `get(id): StoredSubtitle | null`, `list(): StoredSubtitle[]` (only uploads that have a file), `update(id, patch: Partial<Pick<StoredSubtitle, 'name' | 'language' | 'offsetMs' | 'attachment'>>): StoredSubtitle | null`, `delete(id): boolean`, `filePath(id): string | null`, `fontPath(id, name): string | null`.
  - Throws `TooLargeError` (per-file or 2 GB total) and `BadNameError` (names: 1–255 chars, no `/`, `\`, NUL, not `.`/`..`; subtitle names end in `.srt`, `.ass` or `.ssa`; font names in `.ttf`, `.otf`, `.ttc`, `.woff`, `.woff2`).
  - Writes `meta.json` with `replaceAtomically` under `lockFile` (as `PlaybackStore` does); removes temp files of uploads that never got a subtitle file after 1 hour (on `list`).

- [ ] **Step 1: Write the failing tests:** create → not in `list()` until `writeFile`; writeFile over 5 MiB → `TooLargeError` and no file left (Review Focus 2); fonts over 50 MiB in sum → `TooLargeError`; the 2 GB total (use `maxTotalBytes: 1_000`); `BadNameError` for `../x.ttf`, `a/b.ass`, `x\0.ass`, `.`, a 256-char name, `x.exe` (Review Focus 3); update/delete; same-name font replaces; a stale upload with no file after 1 h is removed.
- [ ] **Step 2: Run** `npx vitest run server/src/subtitle-store.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): a store for owner-uploaded subtitles`.

### Task 2: Subtitle routes

**Files:**
- Create: `server/src/routes/subtitles.ts`, `server/src/routes/subtitles.test.ts`
- Modify: `server/src/http.ts` (move `readBody` there from `routes/bdj-store.ts`, exported, as a streaming `AsyncIterable` reader with a byte limit), `server/src/routes/bdj-store.ts` (use it), `server/src/app.ts`, `server/src/main.ts`

**Interfaces:**
- Consumes: Task 1; `requestDevice`, the gate (`device.owner || service.gate() === 'everyone'`, as `routes/playback.ts` does); `library.evidence()` for disc keys; `catalogue().detail(titleId)`.
- Produces (token required on every route):
  - `GET /api/subtitles?discKey=<k>` and `GET /api/subtitles?titleId=<id>` → `StoredSubtitle[]` with `attached` set; non-owners get only `attached !== false`. 404 to a guest under the closed gate.
  - `GET /api/subtitles/<id>/file`, `GET /api/subtitles/<id>/fonts/<name>` → the bytes (`Content-Type: application/octet-stream`, `Content-Length`), same gate.
  - Owners only (403 `forbidden` otherwise): `POST /api/subtitles` (JSON `{ name, language, offsetMs, for: { kind: 'episode', titleId, seasonId, episode } | { kind: 'chapter', discId, playlistId, chapter } }`) → 201 `StoredSubtitle` — the server resolves `for` to an attachment: an episode through the catalogue's `EpisodeRef` (`discId` → its `discKey` from evidence, `playlistId`), a chapter through the disc's evidence (`discKey`; the playlist must be one of the disc's playlists); unresolvable → 400 `{ error: 'not-found' }`. `PUT /api/subtitles/<id>/file/<fileName>` and `PUT /api/subtitles/<id>/fonts/<fontName>` (raw body) → 200 `StoredSubtitle`; 413 `{ error: 'too-large' }`, 400 `{ error: 'bad-name' }`. `PATCH /api/subtitles/<id>` (JSON, same `for` form to re-attach) → 200. `DELETE /api/subtitles/<id>` → 204.
  - `attached`: false when the attachment's `discKey` resolves to no listed disc, or its `playlistId` isn't in that disc's evidence playlists.
- [ ] **Step 1: Write the failing tests** (pattern of `routes/playback.test.ts`, owner and guest persons; a title library fixture as in `routes/titles.test.ts`): owner creates (episode and chapter forms), uploads a file and a font, lists by `discKey` and `titleId`, downloads both; a guest gets 403 on every write and nothing changes, 404 on reads under the closed gate, 200 under `everyone` (Review Focus 1); 413 on a 6 MB subtitle and on fonts past 50 MB in sum; 400 `bad-name`; an attachment whose disc is gone is `attached: false` for the owner and absent for the guest; PATCH re-attaches; DELETE removes files and meta; `readBody` still serves the BD-J store's tests.
- [ ] **Step 2: Run** `npx vitest run server/src/routes/subtitles.test.ts server/src/routes/bdj-store.test.ts`. Expected: FAIL (new routes).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run server/src`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): subtitle routes, owners write and everyone paired reads`.

### Task 3: Client API and the subtitle model

**Files:**
- Modify: `src/ui/nas/nas-client.ts`, `src/ui/nas/nas-client.test.ts`
- Create: `src/ui/nas/subtitle-model.ts`, `src/ui/nas/subtitle-model.test.ts`

**Interfaces:**
- Produces:
  - `NasClient.subtitlesForDisc(discKey, opts?: { timeoutMs?: number }): Promise<StoredSubtitle[]>`, `subtitlesForTitle(titleId): Promise<StoredSubtitle[]>`, `subtitleFiles(s: StoredSubtitle): Promise<File[]>` (the subtitle file, then its fonts, as `File`s named as stored), `createSubtitle(body): Promise<StoredSubtitle>`, `uploadSubtitleFile(id, file: File, onProgress?: (sent: number) => void)`, `uploadSubtitleFont(id, file: File)`, `updateSubtitle(id, patch)`, `deleteSubtitle(id)`. Uploads send the `File` as the raw body (works over HTTPS and over the WebRTC route, which chunks bodies).
  - `subtitle-model.ts` (pure): `LANGUAGES: readonly { code: string; label: string }[]` (en, ja, zh-Hans, zh-Hant, ko, fr, de, es, it, pt, ru — my call; free text allowed); `validateUpload(files: readonly File[]): { subtitle: File; fonts: File[] } | { error: string }` (exactly one `.srt/.ass/.ssa`, ≤ 5 MB; fonts ≤ 50 MB in sum; the copy for each error); `tagsByEpisode(subs: readonly StoredSubtitle[], seasonId: string): Map<number, string[]>` (episode number → language codes, sorted, unique); `forPlaylist(subs, discKey, playlistId): StoredSubtitle[]`; `startFor(s: StoredSubtitle, chapters: readonly { startUs: number }[]): number | null` (episode → 0; chapter → that chapter's start, or null when the chapter doesn't exist); `sameLanguage(subs, language): StoredSubtitle | null`.
- [ ] **Step 1: Write the failing tests** for each function at its edges (two subtitle files → error; a font-only pick → error; 5 MB + 1 byte → error; chapter 3 of 2 → null; tags de-duplicated), and the client methods with a fake fetch (paths, methods, raw body, 403 → `NasHttpError`).
- [ ] **Step 2: Run** `npx vitest run src/ui/nas/subtitle-model.test.ts src/ui/nas/nas-client.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): the subtitle store's client and rules`.

### Task 4: Owners upload and manage subtitles

**Files:**
- Create: `src/ui/nas/SubtitleUpload.tsx`, `src/ui/nas/SubtitleList.tsx`
- Modify: `src/ui/nas/SeasonScreen.tsx` (header button, language tags on episode rows, owner list), `src/ui/nas/SeriesScreen.tsx` (a movie's discs: the same button and list), `src/ui/nas/TitleLibrary.tsx` (pass `owner` and the client), `src/ui/styles.css`, `tests/e2e/nas.spec.ts`

**Interfaces:**
- Consumes: Task 3.
- Produces:
  - An owner-only "＋ Subtitles" button (`data-testid="subtitle-add"`) on the season screen header and on a movie's screen; it opens `SubtitleUpload` (`data-testid="subtitle-upload"`): a file input taking the subtitle and its fonts (`subtitle-upload-files`), "For" (`subtitle-upload-for`: the season's episodes, or "A disc and chapter…" which shows a disc select of the season's or movie's copies, a playlist select from that disc's manifest — playlists of a minute or more, the main one first — and a chapter number), language (`subtitle-upload-language`, a datalist of `LANGUAGES`), name, default offset in seconds (one decimal), Upload (`subtitle-upload-submit`) with progress; errors from `validateUpload` and from the NAS shown inline. Order: `createSubtitle`, then the file, then each font; a failure after create deletes the upload (Review Focus 2).
  - Episode rows show language tags (`<span class="tag" data-testid="episode-subtitle-tag">EN</span>`, uppercase primary subtag) from `subtitlesForTitle` + `tagsByEpisode`, for everyone.
  - Owners see `SubtitleList` (`data-testid="subtitle-list"`) under the episodes: each upload's name, language, attachment, "Not attached" mark, Edit (name, language, offset, attachment — the same form, prefilled) and Delete with a confirm.
- [ ] **Step 1: Write the failing E2E tests** (`nas.spec.ts`, project owner): `test('an owner uploads subtitles with a font for an episode, and everyone sees its language')` — open Starfall Wanderer S1, "＋ Subtitles", pick `tests/e2e/fixtures/ep1.ass` and `fixtures/ass/fonts/DejaVuSans.ttf`, For "Episode 1", language `en`, offset 0.4, Upload → the list shows it, episode 1 shows `EN`; a guest (pair as in the existing guest tests, gate `everyone`) sees `EN` and no "＋ Subtitles" and no list. `test('an owner deletes an upload')`. `test('an upload with two subtitle files is refused before anything is sent')`.
- [ ] **Step 2: Run** `npx playwright test tests/e2e/nas.spec.ts --project=chromium -g "subtitles|upload"`. Expected: FAIL.
- [ ] **Step 3: Implement**, styled in the existing dark theme (mockup 3, spec §9).
- [ ] **Step 4: Run** the same plus `npx vitest run src/ui`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): owners upload and manage subtitles on the season and movie screens`.

### Task 5: Picking a stored subtitle in the player

**Files:**
- Modify: `src/ui/SubtitleMenu.tsx` (new prop `stored: { items: StoredSubtitle[]; activeId: string | null; onPick: (s) => void } | null`; a "From the NAS" group between the file rows/Remove and "Load subtitle files…", rows `subtitle-stored-<id>` with name and language), `src/ui/ControlBar.tsx`, `src/ui/PlayerScreen.tsx`, `src/ui/place-saver.ts` (new `noteStoredSubtitle(fileName: string, id: string, size: number)`), `tests/e2e/nas.spec.ts`
- Create: `src/ui/nas/stored-subtitle-pick.ts`, `src/ui/nas/stored-subtitle-pick.test.ts`

**Interfaces:**
- Consumes: Task 3; `PlayerController.loadSubtitleFiles`, `setSubtitleStart`, `shiftSubtitleFile`, `selectSubtitle`; the open NAS disc's `discKey` and `currentPlaylistId` (known to `PlayerScreen` through the saver's target / `PlayingRoute`).
- Produces:
  - `PlayerScreen` loads `subtitlesForDisc(discKey, { timeoutMs: 3000 })` when a NAS disc opens (none for local discs) and passes `forPlaylist(…, currentPlaylistId)` to the menu.
  - `pickStoredSubtitle(deps: { nas; controller; places; snapshot: () => PlayerSnapshot }, s: StoredSubtitle): Promise<void>` (stored-subtitle-pick.ts): fetches `subtitleFiles(s)`, `controller.loadSubtitleFiles(files)` (it replaces the text set, as a local pick does — Review Focus 4), waits (≤ 10 s) for the snapshot to list `s.fileName`, then `setSubtitleStart(i, startFor(s, chapters))` when not null, `shiftSubtitleFile(i, s.offsetMs - current)`, `selectSubtitle({ kind: 'text' })`, and `places.noteStoredSubtitle(s.fileName, s.id, s.fileSize)`. A failed fetch shows the existing notice style "Couldn't load the subtitles from the NAS." and changes nothing.
  - The active row shows checked; a later local pick clears `activeId`.
- [ ] **Step 1: Write the failing tests:** unit (fakes): placement at a chapter start, default offset applied once, a failed fetch leaves the set untouched, a pick while local files are loaded replaces them and notes the id. E2E `test('everyone picks a stored subtitle in the player, at its default offset')`: with the Task 4 upload in place (create it through the owner API in the test), play episode 1, Subtitles → From the NAS → the `en` row → `subtitle-file-0` shows `ep1.ass` with offset +0.4 s and text is selected.
- [ ] **Step 2: Run** `npx vitest run src/ui/nas/stored-subtitle-pick.test.ts && npx playwright test tests/e2e/nas.spec.ts --project=chromium -g "stored subtitle"`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same plus `npx vitest run src/ui`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): stored subtitles in the player's Subtitles menu`.

### Task 6: Stored subtitles in places, resume and Up next

**Files:**
- Modify: `src/engine/disc/nas-api.ts` (`PlaceTextFile.subtitleId?: string`), `server/src/playback-store.ts` (validator accepts an optional `subtitleId`, 1–64 chars), `src/ui/place-model.ts` (`buildPlace` copies the id from `storedSubtitleIds: Record<fileName, id>`), `src/ui/place-saver.ts`, `src/ui/place-apply.ts`, `src/ui/place-model.ts` (`settingsForUpNext` keeps a stored file's language), their tests, `tests/e2e/nas.spec.ts`

**Interfaces:**
- Consumes: Tasks 3, 5; piece 2's `LaunchSettingsApplier`, `settingsForUpNext`.
- Produces:
  - A place's `textFiles` entry for a stored subtitle carries `subtitleId` (and its viewer offset as for any file).
  - On a resumed launch, `place-apply` re-adds stored subtitles by fetching them from the NAS (`subtitleFiles` of the `StoredSubtitle` found in `subtitlesForDisc`), then restores placement and the viewer's offset as it does for local files; a fetch failure or a missing upload skips that file silently and playback goes on (Review Focus 5).
  - Up next: when the previous episode's place used a stored subtitle of language L, the next episode's launch picks the next episode's stored subtitle of language L (`sameLanguage`) at its default offset; none → no text subtitle (PG by language as today).
- [ ] **Step 1: Write the failing tests:** place-model (`subtitleId` copied), playback-store validator (accepts `subtitleId`, rejects 65 chars), place-apply (a stored file re-fetched and offset restored; a failing fetch skips it and the rest applies), Up next language carry. E2E `test('a stored subtitle and my offset come back when I resume')` (`?placemin=1`): pick the stored subtitle, nudge the offset +0.5 s (to +0.9), pause at ≥ 3 s, reopen → Resume → `subtitle-file-0` is `ep1.ass` at +0.9 s.
- [ ] **Step 2: Run** `npx vitest run src/ui server/src/playback-store.test.ts && npx playwright test tests/e2e/nas.spec.ts --project=chromium -g "come back when I resume"`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run src/ui server/src && npx playwright test tests/e2e/nas.spec.ts --project=chromium --project=webkit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): stored subtitles live in places, come back on resume and carry to Up next`.

### Task 7: Docs

**Files:**
- Modify: `CLAUDE.md` (status sentence; a "Subtitle store" paragraph: `SubtitleStore`, `/data/subtitles/<id>/`, `routes/subtitles.ts`, limits, attachments and `attached`, the gate, `subtitle-model.ts`, `SubtitleUpload`/`SubtitleList`, the menu's "From the NAS", `stored-subtitle-pick.ts`, `subtitleId` in places), `docs/known-issues.md` (anything left open on purpose)

- [ ] **Step 1: Edit** both files.
- [ ] **Step 2: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 3: Commit** `docs: the NAS subtitle store`.
