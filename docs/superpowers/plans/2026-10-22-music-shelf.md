# Music Shelf by Artist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The NAS library's Music shelf becomes a grid of artists, each opening a page of their releases as covers, with names, dates, kinds and covers from MusicBrainz, Discogs, the disc and the release folder.

**Architecture:** The NAS keeps one music title per release folder (as today) and adds a `music` field to each music `TitleSummary` (artist, kind, date, concert name) plus a cover poster. Lookups by catalogue number run in the title service after matching, cached in `metadata.json`; a pure `musicInfo` function decides names, kind and artist grouping from the lookup, the disc evidence, the folder name and the owner's choice. The client groups the Music shelf's titles by artist; tapping a release opens the existing pre-flight.

**Tech Stack:** TypeScript (strict), Node server bundled to `server/dist/server.mjs` (no native deps), React client, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-22-music-shelf-design.md`

## Global Constraints

- The NAS server has no native dependencies and writes only under `/data`; the library mounts are read-only (folder covers are read, then copied into the art cache under `/data/art`).
- MusicBrainz: at most one request per 1.1 s (`new Pacer(1, 1_100)`), every request with `User-Agent: bluray-web/1.0 (https://github.com/brianhvo02/bluray-web)`.
- Discogs only when `DISCOGS_TOKEN` is set in the NAS's `.env`; the token is never logged, put in errors or in the repo. Pace `new Pacer(50, 60_000)` (under Discogs' 60/min authenticated limit).
- The repo is public: every fixture, test and recorded answer uses made-up artists, titles and catalogue numbers (for example the artist "Lantern Parade", catalogue `ZQCL-2468`).
- Art is served only through `GET art/<artId>` as art ids, never source URLs or file paths; folder images over 5 MB (the art cache's body limit) are skipped.
- No user-agent sniffing; touch and phone widths must not overflow horizontally.
- `TITLE_LIBRARY` gates music like every title route (no new route bypasses it).
- Copy (exact): section headings `Concerts`, `Albums & singles`, `Other`; the artist tile count `1 release` / `N releases`; the Various artists tile name `Various artists`; menu items `Rename…`, `Set artist…`, `Not this release`, `Use this release again`, `File differently…`.

## Review Focus

1. A release whose folder name has no ` - ` separator and no lookup: it must still get an artist (the folder's parent folder name when that isn't `Music`, else Various artists) and a clean title, never an empty name. → Task 1 test `parses a folder with no separator`, Task 5 test `no lookup and no artist goes to Various artists`.
2. The same artist written two ways (full-width letters, different case, `・` vs space) across releases with no lookup: one tile, not two. → Task 5 test `normalized names group together`.
3. A MusicBrainz answer that is HTTP 503 or rate limited: the release stays as it was (cached value kept, not replaced by a miss) and is retried later. → Task 2 test `a 503 is a source failure, not a miss`, Task 6 test `a failed lookup keeps the cached release`.
4. A folder with a 30 MB `Front.png` scan and a small `cover.jpg`: the small one is served; with only the big scan, the Cover Art Archive cover is used. → Task 4 tests.
5. A phone at 393 px wide on the Music shelf and an artist page: nothing wider than the viewport. → Task 8 E2E step checks `document.documentElement.scrollWidth <= innerWidth`.

---

### Task 1: Music folder-name parser and concert words

**Files:**
- Create: `server/src/titles/music-name.ts`
- Test: `server/src/titles/music-name.test.ts`

**Interfaces:**
- Produces:
  - `interface ParsedMusicName { readonly date: string | null; readonly artist: string | null; readonly title: string; readonly single: boolean }` (`date` as `YYYY`, `YYYY-MM` or `YYYY-MM-DD`)
  - `parseMusicFolder(name: string): ParsedMusicName`
  - `hasConcertWord(text: string): boolean`

- [ ] **Step 1: Write the failing tests** (made-up names only)

```ts
import { describe, expect, it } from 'vitest';
import { hasConcertWord, parseMusicFolder } from './music-name';

describe('parseMusicFolder', () => {
  it('reads a dated artist - title folder and strips the rip tags', () => {
    expect(parseMusicFolder('[2021.06.02] Lantern Parade - Night Lights [CD][FLAC+CUE+LOG+BK+BDMV][ZQCL-2468~9]')).toEqual({ date: '2021-06-02', artist: 'Lantern Parade', title: 'Night Lights', single: false });
  });
  it('drops edition notes and accepts en and em dashes', () => {
    expect(parseMusicFolder('[2020.01.15] 星野あおい – 3分29秒 [期間生産限定盤] [CD][FLAC+CUE+LOG+BK+BDMV][ZQCL-1000]')).toMatchObject({ artist: '星野あおい', title: '3分29秒' });
    expect(parseMusicFolder('Neon Harbor — Tidelines (2019)')).toMatchObject({ artist: 'Neon Harbor', title: 'Tidelines', date: '2019' });
  });
  it('marks a single', () => {
    expect(parseMusicFolder('Neon Harbor - Freedom (Single) Some Show OP2').single).toBe(true);
  });
  it('parses a folder with no separator', () => {
    expect(parseMusicFolder('Paper Lanterns Hall Concert 2018 [ZQCL-3000]')).toEqual({ date: null, artist: null, title: 'Paper Lanterns Hall Concert 2018', single: false });
  });
});

describe('hasConcertWord', () => {
  it.each(['Blue Hour TOUR 2023', 'Live at the Hall', 'Hall Concert', '十周年記念公演', 'ライブ2020', 'ツアー', 'コンサート'])('finds %s', (t) => expect(hasConcertWord(t)).toBe(true));
  it.each(['Deliver', 'Olive Garden', 'Tourmaline'])('not %s', (t) => expect(hasConcertWord(t)).toBe(false));
});
```

- [ ] **Step 2: Run to see them fail:** `npx vitest run server/src/titles/music-name.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** in `music-name.ts`. Date forms: leading `[YYYY.MM.DD]`, `[YYYY-MM-DD]`, `(YYYY)` anywhere. Bracketed `[...]` groups are removed whole; `(Single)` sets `single` and is removed; other `(...)` groups stay. The artist/title split is the first ` - `, ` – ` or ` — `. Latin concert words (`live`, `tour`, `concert`) match as whole words, case-insensitive; Japanese ones (`ライブ`, `ツアー`, `公演`, `コンサート`) as substrings. Original code.
- [ ] **Step 4: Run:** same command → PASS.
- [ ] **Step 5: Commit** `feat(music): parse music release folder names`.

### Task 2: MusicBrainz client

**Files:**
- Create: `server/src/titles/music-sources.ts` (types and fixture source), `server/src/titles/musicbrainz.ts`
- Test: `server/src/titles/musicbrainz.test.ts`, fixtures `server/src/titles/fixtures/musicbrainz/*.json` (made-up, shaped like MusicBrainz `ws/2/release?query=catno:` answers with `inc` artist-credits)

**Interfaces:**
- Produces (in `music-sources.ts`):
  - `interface MusicArtist { readonly id: string; readonly name: string; readonly sortName: string | null; readonly aliases: readonly { readonly name: string; readonly locale: string | null; readonly primary: boolean }[] }`
  - `interface MusicRelease { readonly source: 'musicbrainz' | 'discogs'; readonly id: string; readonly title: string; readonly date: string | null; readonly artists: readonly MusicArtist[]; readonly primaryType: string | null; readonly secondaryTypes: readonly string[]; readonly live: boolean; readonly cover: { readonly small: string; readonly large: string } | null }`
  - `interface MusicSource { byCatalogue(catalogueNumber: string): Promise<MusicRelease | null> }`. It throws `SourceUnavailable` (from `./sources`) on a network error, 5xx or rate limiting, and returns null for a miss.
  - `VARIOUS_ARTISTS_MBID = '89ad4ac3-39f7-470e-963a-56509c546377'`
  - `fixtureMusicSource(recorded: Readonly<Record<string, MusicRelease>>): MusicSource` (keyed by catalogue number)
- Produces (in `musicbrainz.ts`): `createMusicBrainz(fetch: typeof globalThis.fetch, pacer: Pacer): MusicSource`

- [ ] **Step 1: Write the failing tests** with a fake `fetch` answering the fixture JSON:
  - `accepts only an exact catalogue number`: a result whose label-info has `ZQCL-2469` is not returned for `ZQCL-2468`; `zqcl 2468` in label-info is accepted (spaces and case ignored).
  - `prefers a Blu-ray release, then JP, then the earliest`: three exact hits (CD-only 2019 JP; CD+Blu-ray 2020 US; CD+Blu-ray 2021 JP) → the 2021 JP one.
  - `several exact hits naming different artists are a miss` → null.
  - `maps the release`: `title`, `date`, `artists[0]` (id, name, sort-name, aliases with locale and primary), `primaryType`, `secondaryTypes`, `live` true when secondary types contain `Live`, `cover` = `{ small: 'https://coverartarchive.org/release/<id>/front-250', large: 'https://coverartarchive.org/release/<id>/front-500' }` only when `cover-art-archive.front` is true.
  - `sends the User-Agent and paces through the pacer`: the request's `User-Agent` header equals the Global Constraints value.
  - `a 503 is a source failure, not a miss`: a 503 throws `SourceUnavailable`.
- [ ] **Step 2: Run:** `npx vitest run server/src/titles/musicbrainz.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Search URL `https://musicbrainz.org/ws/2/release?query=catno:%22<catno>%22&fmt=json&limit=25`. The search answer lacks aliases and cover flags, so for the chosen release fetch `https://musicbrainz.org/ws/2/release/<id>?inc=artist-credits+release-groups+media+aliases&fmt=json` through the same pacer (aliases come with `artist-credits` plus `aliases`). Rate-limit answers (503, 429) become `RateLimited` for the pacer as `anilist.ts` does.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(music): MusicBrainz lookup by catalogue number`.

### Task 3: Discogs client and config

**Files:**
- Create: `server/src/titles/discogs.ts`
- Modify: `server/src/config.ts` (add `discogsToken: string | null` from `DISCOGS_TOKEN`, null when unset or empty; never logged)
- Test: `server/src/titles/discogs.test.ts`, `server/src/config.test.ts` (one case), fixtures `server/src/titles/fixtures/discogs/*.json` (made-up)

**Interfaces:**
- Consumes: `MusicRelease`, `MusicSource` (Task 2).
- Produces: `createDiscogs(fetch: typeof globalThis.fetch, pacer: Pacer, token: string): MusicSource`; `Config.discogsToken`.

- [ ] **Step 1: Write the failing tests:** an exact `catno` hit maps to a `MusicRelease` with `source: 'discogs'`, `id: 'discogs:<id>'`, `artists[0].id: 'discogs-artist:<id>'` (with the `(2)` disambiguation suffix stripped from the name), `date` from `released`, `live` true when a format description is `Live`, `cover` from the release's primary image (`uri150` small, `uri` large); the request carries `Authorization: Discogs token=<token>` and the Global Constraints `User-Agent`; a hit whose `catno` differs is a miss; a 429 or 5xx throws `SourceUnavailable`; an error message never contains the token (assert `String(err)` doesn't include it). Config: `DISCOGS_TOKEN=''` → null.
- [ ] **Step 2: Run** `npx vitest run server/src/titles/discogs.test.ts server/src/config.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Search `https://api.discogs.com/database/search?catno=<catno>&type=release&per_page=25`, then `https://api.discogs.com/releases/<id>` for the chosen one. The choice rule is the same as Task 2 (prefer a `Blu-ray` format, then country `Japan`, then the earliest; disagreeing first artists → miss).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(music): Discogs lookup when a token is set`.

### Task 4: Folder covers and new art hosts

**Files:**
- Create: `server/src/titles/folder-cover.ts`
- Modify: `server/src/titles/art.ts` (allowed hosts; a local file source)
- Test: `server/src/titles/folder-cover.test.ts`, `server/src/titles/art.test.ts`

**Interfaces:**
- Produces:
  - `findFolderCover(dir: string, listDir: ListDir, statSize: (abs: string) => Promise<number | null>): Promise<string | null>` (an absolute path, or null)
  - `ArtCache.get(artId: string, size: 'small' | 'large', source: string | { readonly file: string }): Promise<{ path: string; type: string } | null>`: a `{ file }` source is copied from disk into the cache (both sizes the same file), with the same 5 MB limit; its type comes from its first bytes (JPEG `FF D8 FF`, PNG `89 50 4E 47`, WebP `RIFF....WEBP`), never from the extension.
  - Art hosts: `ART_HOSTS` gains `coverartarchive.org` and `i.discogs.com`, and any host ending in `.archive.org`. The fetch follows redirects only to allowed hosts.

- [ ] **Step 1: Write the failing tests:**
  - `folder-cover`: picks `cover.jpg` over `Front.png` and `zz.png`; picks `Front.PNG` when there's no cover (case-insensitive); falls back to the first image (name order) at the top level; ignores subfolders and non-images; skips a 30 MB `Front.png` for a 200 KB `zz.jpg`; with only a 30 MB file → null.
  - `art`: a `coverartarchive.org` URL redirecting to `ia800000.us.archive.org` is fetched; a redirect to `evil.example` is refused (null); a `{ file }` PNG is served with type `image/png`; a `{ file }` holding SVG text → null.
- [ ] **Step 2: Run** `npx vitest run server/src/titles/folder-cover.test.ts server/src/titles/art.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Name priority (first match wins, base name without extension, case-insensitive): `cover`, `front`, `folder`, `jacket`, `jk`; extensions `jpg`, `jpeg`, `png`, `webp`; a file over 5 MB (`5 * 1024 * 1024`) is skipped and the search continues.
- [ ] **Step 4: Run** → PASS, plus `npx vitest run server/src/titles` to check nothing else broke.
- [ ] **Step 5: Commit** `feat(music): folder covers and Cover Art Archive and Discogs art`.

### Task 5: `musicInfo`, the pure decision

**Files:**
- Create: `server/src/titles/music-info.ts`
- Modify: `src/engine/disc/nas-api.ts` (types below)
- Test: `server/src/titles/music-info.test.ts`

**Interfaces:**
- Consumes: `parseMusicFolder`, `hasConcertWord` (Task 1); `MusicRelease`, `VARIOUS_ARTISTS_MBID` (Task 2); `DiscEvidence`.
- Produces:
  - in `nas-api.ts`: `type MusicKind = 'concert' | 'album' | 'single' | 'other'`; `interface TitleMusic { readonly artist: { readonly id: string; readonly name: string; readonly otherName: string | null }; readonly kind: MusicKind; readonly date: string | null; readonly concertName: string | null; readonly title: string; readonly matched: boolean; readonly rejected: boolean }`; `TitleSummary` gains `readonly music?: TitleMusic`.
  - `OwnerChoice`'s music variant becomes `{ readonly kind: 'music'; readonly name: string | null; readonly artist?: string | null; readonly rejectMatch?: boolean }`.
  - `musicInfo(o: { releaseFolder: string; parentFolder: string | null; evidence: readonly DiscEvidence[]; lookup: MusicRelease | null; ownerArtist: string | null; rejectMatch: boolean }): TitleMusic`
  - `artistKey(name: string): string` (NFKC, case-folded, `・`, `·` and runs of spaces collapsed to one space, trimmed)
  - `VARIOUS_ID = 'various'`

- [ ] **Step 1: Write the failing tests:**
  - `uses the lookup`: title, date, `artist.id` = MusicBrainz id, `matched: true`.
  - `headline is the Latin name`: artist name `星野あおい` with alias `{ name: 'Aoi Hoshino', locale: 'ja-Latn', primary: true }` → `{ name: 'Aoi Hoshino', otherName: '星野あおい' }`; with no Latin alias and sort-name `Hoshino, Aoi` → `name: 'Aoi Hoshino'`; a Latin MusicBrainz name → `otherName: null`.
  - `various artists`: lookup artist id `VARIOUS_ARTISTS_MBID` → `artist.id: 'various'`, name `Various artists`; a release group with secondary type `Soundtrack` or `Compilation` → various.
  - `owner artist wins`: `ownerArtist: 'Neon Harbor'` over a lookup naming someone else → `artist.id: 'name:' + artistKey('Neon Harbor')`; `ownerArtist: 'various'` → various.
  - `rejectMatch ignores the lookup`: same input with `rejectMatch: true` → the parsed folder title and artist, `matched: false`, `rejected: true`.
  - `kind`: `live` → concert; a bdmt name or the folder name with a concert word → concert; primary type `Single` or parsed `single` → single; `Album`/`EP` → album; otherwise other.
  - `concert name from the disc`: a bdmt name different from the title (after `normalizeTitle`) → `concertName`; equal → null.
  - `normalized names group together`: `artistKey('ＬＡＮＴＥＲＮ　Parade')` equals `artistKey('lantern parade')`, and `artistKey('ミナト・楽団') === artistKey('ミナト 楽団')`.
  - `no lookup and no artist goes to Various artists`: folder `Paper Lanterns Hall Concert 2018`, parent `Music` → various; parent `Paper Lanterns` → artist `Paper Lanterns`.
- [ ] **Step 2: Run** `npx vitest run server/src/titles/music-info.test.ts` → FAIL.
- [ ] **Step 3: Implement.** An artist without a MusicBrainz or Discogs id gets the id `name:<artistKey(name)>`. The Latin-script test is "no character outside Latin, digits, punctuation and spaces". The first artist of the credit decides. Original code.
- [ ] **Step 4: Run** → PASS; `npm run typecheck` passes.
- [ ] **Step 5: Commit** `feat(music): decide a release's artist, kind and names`.

### Task 6: Lookups in the title service, music in the catalogue

**Files:**
- Modify: `server/src/titles/service.ts`, `server/src/titles/catalogue.ts`, `server/src/titles/owner-store.ts` (validate the new choice fields), `server/src/main.ts` (wire sources; `MUSIC_FIXTURE` env for tests, like `METADATA_FIXTURE`)
- Test: `server/src/titles/service.test.ts`, `server/src/titles/catalogue.test.ts`, `server/src/titles/owner-store.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces:
  - `TitleServiceOptions` gains `readonly musicbrainz: MusicSource | null; readonly discogs: MusicSource | null; readonly folderCover: (releaseDir: string) => Promise<string | null>; readonly locateRelease: (discId: string, group: string) => string | null` (the release folder's absolute path, from `library.locate` minus the disc's segments below the group).
  - `metadata.json` gains `music: Record<string, Dated<MusicRelease | null>>` (by catalogue number) and `folderCovers: Record<string, string | null>` (by release group). Both are optional when loading, so older files load.
  - `CatalogueInput` gains `music: ReadonlyMap<string, MusicRelease | null>`, `folderCovers: ReadonlyMap<string, string | null>`, `parentFolders` derivable from evidence (no new input).
  - `Catalogue.art(id)` returns `{ small: string; large: string } | { file: string } | null`, and `routes/titles.ts` passes either to `ArtCache.get`.
  - Music titles in `catalogue.titles` carry `music` (from `musicInfo`) and `poster`: the folder cover's art id when there is one, else the lookup cover's (unless `rejectMatch`), else null. A folder cover's art id is `artIdOf({ small: 'file:' + path, large: 'file:' + path })`.

- [ ] **Step 1: Write the failing tests:**
  - service: after a run, a music disc whose evidence has `catalogueNumbers: ['ZQCL-2468']` is looked up once in `musicbrainz`; on a miss with `discogs` present, Discogs is asked, and also on a MusicBrainz hit with no cover (only Discogs' cover is used then); the result is in `metadata.json` and survives a restart with no network; `a failed lookup keeps the cached release` (the source throws `SourceUnavailable` on the refresh run, and the earlier release is still served); hits refresh after 30 days and misses after 7 (`REFRESH_MS`, `RETRY_UNSORTED_MS`); a multi-disc release uses the first disc (path order) whose lookup hit.
  - catalogue: a music title's `music` and `poster` follow the rules above; `rejectMatch` on its disc's choice drops the lookup and the lookup cover; the owner's `artist` wins.
  - owner-store: `{ kind: 'music', name: null, artist: 'Neon Harbor', rejectMatch: true }` round-trips; `artist: 42` is refused.
- [ ] **Step 2: Run** `npx vitest run server/src/titles` → the new tests FAIL.
- [ ] **Step 3: Implement.** Lookups run after matching in `run()`, only for discs whose match is `music`, through the pacer, never blocking the catalogue: the catalogue is rebuilt after the lookups as after matching. Folder covers are found once per group when the group's evidence key changes. In `main.ts`, `musicbrainz` is `createMusicBrainz(fetch, new Pacer(1, 1_100))`; `discogs` is `createDiscogs(...)` only with `config.discogsToken`, else null with a log line `Discogs token not set: music lookups use MusicBrainz only`. With `MUSIC_FIXTURE` set, both come from `fixtureMusicSource` and Discogs is null.
- [ ] **Step 4: Run** `npx vitest run server` and `npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(music): look up music releases and add them to the catalogue`.

### Task 7: Owner corrections route and client call

**Files:**
- Modify: `server/src/routes/admin.ts` (new `PUT music/:id`), `src/ui/nas/nas-client.ts` (`admin.setMusic`)
- Test: `server/src/routes/admin.test.ts`, `src/ui/nas/nas-client.test.ts`

**Interfaces:**
- Produces:
  - `PUT /api/admin/music/<titleId>` with body `{ artist?: string | null; rejectMatch?: boolean }`: 204; 404 for an id that isn't a non-own music title; 400 for a bad body (artist over 200 characters, empty after trimming, or neither field). It writes the fields into the music choice of every disc of the release, keeping the choice's `name`, following the copy rules of `PUT names/:id`, then rebuilds.
  - `NasClient.admin.setMusic(titleId: string, change: { readonly artist?: string | null; readonly rejectMatch?: boolean }): Promise<void>`

- [ ] **Step 1: Write the failing tests:** route writes `artist` and `rejectMatch` to both discs of a two-disc release and keeps an existing `name`; `artist: null` clears it; a guest device gets 403 as for the other admin routes; unknown id → 404. Client: sends `PUT admin/music/<encoded id>` with the JSON body.
- [ ] **Step 2: Run** `npx vitest run server/src/routes/admin.test.ts src/ui/nas/nas-client.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(music): owner sets a release's artist or rejects its match`.

### Task 8: Client artist grid, artist page and owner menu

**Files:**
- Create: `src/ui/nas/artist-model.ts`, `src/ui/nas/ArtistGrid.tsx`, `src/ui/nas/ArtistPage.tsx`, `src/ui/nas/MusicReleaseMenu.tsx`
- Modify: `src/ui/nas/MusicScreen.tsx` (becomes the router between grid and page; the old list rows go), `src/ui/nas/TitleLibrary.tsx` (alphabet bars and search on Music use artists; route), `src/ui/nas/nas-route.ts` (new route), `src/ui/styles.css` (chips scroll; grids), `tests/e2e/nas-server.ts`, `tests/e2e/nas.spec.ts`, `tests/e2e/fixtures/` (a made-up `MUSIC_FIXTURE` file)
- Test: `src/ui/nas/artist-model.test.ts`, `src/ui/nas/nas-route.test.ts`, E2E

**Interfaces:**
- Consumes: `TitleSummary.music` (Task 5), `NasClient.admin.setMusic` (Task 7), existing `openDisc(disc: PreflightDisc)` and `openTitle(id)` in `TitleLibrary.tsx`, `AlphabetRail`, `title-index.ts`.
- Produces:
  - `interface ArtistGroup { readonly id: string; readonly name: string; readonly otherName: string | null; readonly releases: readonly TitleSummary[]; readonly index: TitleSummary }` (`index` is a synthetic `TitleSummary` with `names.romaji = name`, `names.native = otherName`, so `englishKey`, `kanaRow` and `japaneseOrder` work unchanged)
  - `groupArtists(titles: readonly TitleSummary[]): ArtistGroup[]` (A–Z by `name`, `various` last)
  - `artistSections(g: ArtistGroup): { readonly concerts: readonly TitleSummary[]; readonly albums: readonly TitleSummary[]; readonly other: readonly TitleSummary[] }` (concert → concerts; album and single → albums; other → other; newest `music.date` first, undated last)
  - `searchArtists(groups: readonly ArtistGroup[], query: string): ArtistGroup[]` (matches artist names, other names and release titles via `normalizeTitle`)
  - `NasRoute` gains `{ kind: 'artist'; artistId: string }`, path `/nas/artist/<encoded id>`.
  - Test ids: `artist-tile` (with `data-artist-id`, `data-name`), `artist-page`, `artist-section` (with `data-section` `concerts|albums|other`), `music-release` (with `data-title-id`, `data-name`), `music-release-menu`, `music-set-artist`, `music-reject`, `music-unreject`, `music-rename`, `music-refile-open` (kept).

- [ ] **Step 1: Write the failing unit tests:** `groupArtists` puts two releases with the same `music.artist.id` on one tile and `various` last; `artistSections` orders `2023-05` before `2021` before undated; `searchArtists('aoi')` finds the artist by name and `searchArtists('night lights')` finds it by a release title; `parseNasRoute`/`nasRoutePath` round-trip `{ kind: 'artist', artistId: 'name:neon harbor' }`.
- [ ] **Step 2: Run** `npx vitest run src/ui/nas/artist-model.test.ts src/ui/nas/nas-route.test.ts` → FAIL.
- [ ] **Step 3: Implement the model and route.** Then the components per spec §3: the artist tile collage is a 2×2 CSS grid of up to four release posters (`/api/art/<id>?size=small` through the existing `Poster` and `LoadQueue`), one poster filling the circle, ♪ with none; the artist page shows `name`, `otherName` and the count, then the three sections (an empty section is not shown); a release card shows the poster, `music.concertName ?? music.title` clamped to two lines, and the year. Tapping a release with one disc opens the pre-flight (`openDisc`) for that disc; with more than one disc, `openTitle(id)` (spec call C5). The owner's "⋯" menu (`MusicReleaseMenu`) holds Rename… (the existing rename form), Set artist… (an input with a datalist of existing artist names plus `Various artists`, saving `setMusic(id, { artist })`, `various` for Various artists), `Not this release` (only when `music.matched`) or `Use this release again` (only when `music.rejected`), and File differently… (the existing refile card). The shelf chips row gets `overflow-x: auto` with no wrapping.
- [ ] **Step 4: Run the unit tests** → PASS; `npm run typecheck` passes.
- [ ] **Step 5: E2E.** In `nas-server.ts`, rename the music fixture folder to `Music/[2024.05.01] Lantern Parade - Night Lights [CD][ZQCL-2468]`, put a small made-up `cover.png` beside its `BDMV` (generated in the test setup), and set `MUSIC_FIXTURE` to a recorded release for `ZQCL-2468` (artist `Lantern Parade`, alias-free, `Live` secondary type, no cover). Update the existing Music tests to the new test ids. Add a test `the Music shelf shows artists and opens a release's pre-flight`: the Music chip shows an `artist-tile` named `Lantern Parade` with `1 release`; it opens `artist-page` with a `concerts` section holding `Night Lights`; the tile and the card show an image (the folder cover); tapping the card opens `nas-preflight`. Add an owner test: Set artist to `Neon Harbor` moves the release to that tile; `Not this release` shows the folder title. On `mobile-chromium` assert `await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)` on the shelf and the artist page. Run `npx playwright test tests/e2e/nas.spec.ts` (by full path) → PASS on chromium, firefox and webkit.
- [ ] **Step 6: Commit** `feat(music): artist grid and artist pages on the Music shelf`.

### Task 9: Docs

**Files:**
- Modify: `CLAUDE.md` (the NAS server paragraph: music lookups, folder covers, `DISCOGS_TOKEN`, `MUSIC_FIXTURE`; the client paragraph: artist grid and page), `docs/known-issues.md` (C4: folder scans over 5 MB skipped; MusicBrainz coverage of about two thirds; a rejected match lasts until undone), the spec's status line.

- [ ] **Step 1:** Write the doc changes; `npm test` and `npm run typecheck` pass.
- [ ] **Step 2: Commit** `docs: music shelf by artist`.
