# NAS Title Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The NAS lists its 2,456 discs as titles (series, movies, music), so that you can search by English, romaji or Japanese name and play an episode or disc. Discs it can't identify with confidence go to an owner-only Unsorted pile.

**Architecture:**
- The NAS server records cheap evidence for each disc during its scan: disc titles, folder names, catalogue numbers, a content fingerprint and playlist lengths.
- It matches folder groups cautiously against AniList, TMDB and a bundled TheDiscDB index, merges in the owner's choices, and serves a catalogue over new JSON routes.
- The app gets Library, Series and Season screens, plus owner-only Unsorted, Hidden and Music screens. A server setting keeps the library owner-only until the spot-check passes.

**Tech Stack:** TypeScript strict, Node 24 `node:http` server (`server/`), React UI (`src/ui/nas/`), Vitest, Playwright, the AniList GraphQL API and the TMDB v3 API.

**Spec:** `docs/superpowers/specs/2026-10-17-nas-library-titles-design.md` (parent: `docs/superpowers/specs/2026-10-17-nas-server-design.md`). Mockups: `https://claude.ai/artifact/JT3HaZAxQ1K4x7uTkSqYXf`.

**Precondition (spec §13 step 1, outside this plan):** the Firefox CI fix (PR #4) is merged, main's deploys are green, the NAS runs step 2 as built, and the user's devices are paired. Task 12 needs a paired owner device.

## Global Constraints

- **Words in the UI (spec §2):**
  - Title (Series, Movie, Music), season, episode, disc, copy, extras.
  - Shelves: Series, Movies, Music, Unsorted.
  - Never "show" for a series.
- **Cautious matching:** a disc is filed only under spec §7's four acceptance rules. Anything else goes to Unsorted with a reason. Owner choices always beat automatic matches.
- **Library mounts are read-only.** Never write under `/mnt` or the library mounts. All state lives in `/data`.
- **Rate limits:** AniList at most 30 requests per minute; TMDB at most 20 per second. A rescan makes no requests for unchanged discs.
- **The TMDB key** comes from env `TMDB_API_KEY` (from the NAS's `~/bluray-server/.env`). It is never committed, never logged and never sent to clients. Without it the server runs on AniList and TheDiscDB only.
- **TMDB attribution, verbatim:** "This product uses the TMDB API but is not endorsed or certified by TMDB", with the TMDB logo, in the app's NAS settings and in `server/NOTICE`.
- **Release gate:**
  - `TITLE_LIBRARY=owners|everyone` (env default `owners`). The owner's setting, stored in `/data`, overrides it.
  - Non-owners get 404 from every title route while the gate is `owners`.
- **Disc IDs don't change**, and neither do existing roots or `GET library?path=` responses, apart from the Downloads merge (Task 1).
- **The server has no native dependencies.** Art comes from the sources' own image sizes; no image resizing.
- **The real library listing is never committed.** It goes in `fixtures/local/library-paths.txt` (gitignored).
- **Code rules:**
  - `src/engine/` must not import from `src/ui/` or `src/player/`.
  - Strict TypeScript, `import type` for type-only imports, `noUnused*`.
  - Touch targets at least 44 px; screens work at phone width.
- **Outward actions need the user's approval:** merges and pushes to main, NAS deploys beyond Task 12's agreed deploy, and the gate switch. The SDD controller stops at Task 12.

## Review Focus

1. **A foreign release whose disc title names a different-language edition** (an Italian "Ember Blade" BD whose bdmt is `ita`, the folder `[ITA]`) must be filed under the same series as the Japanese one, or go to Unsorted. Never under a different series. Test: Task 5.
2. **AniList or TMDB unreachable, or answering 429, in the middle of a run.** Earlier matches stay, the affected groups get reason `source-unreachable` and are retried at the next run, and nothing already filed is dropped. Test: Task 8.
3. **A disc moved while the server was down.** On the next load its old ID is gone and a new ID with the same fingerprint exists, and the owner's choice must follow it. Test: Task 6.
4. **Full-width and mixed-script numbers** (`第２期`, `Ｖｏｌ．３`, `ＤＩＳＣ２`, `上巻`) must parse like their ASCII forms. Test: Task 3.
5. **A guest device while the gate is closed** gets the folder view with no error banner, and the library once the gate opens, on the next app load. Test: Task 10.

---

### Task 1: Downloads roots, the Downloads folder, and discs still downloading

**Files:**
- Modify: `server/deploy/compose.yaml`, `server/src/library.ts`, `server/src/config.ts`
- Test: `server/src/library.test.ts`, `server/src/config.test.ts`

**Interfaces:**
- Produces: a `LibraryRoot` gains `group?: string`, parsed from `LIBRARY_ROOTS` entries written `name=dir@group`. `Library.list('')` shows each group as one folder named after the group, merging its roots' children; `list('<group>')` lists that merge.
- Produces: `Library.isSettled(abs: string, nowMs: number): Promise<boolean>`, used by the scan. Exported constant `SETTLE_MS = 3_600_000`.

- [ ] **Step 1: Write failing tests.**
  - `config.test.ts`: `loadConfig({LIBRARY_ROOTS: 'media1=/a,media1-dl=/b@Downloads'})` gives `roots[1].group === 'Downloads'`. A group equal to a root name throws.
  - `library.test.ts`:
    - With roots `media1` and `media1-dl@Downloads`, `list('')` has a folder `{ name: 'Downloads', path: 'Downloads' }` with the summed disc count, and no `media1-dl` children at the top level.
    - `list('Downloads')` merges the group's children.
    - A disc's `path` still starts with `media1-dl/`, and its ID is unchanged from a scan without the group.
    - A folder disc whose `.m2ts` mtime is 10 minutes before `now` is not listed. At 61 minutes it is listed, at the next scan with an injected `now`.
- [ ] **Step 2: Run** `npx vitest run server/src/library.test.ts server/src/config.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The settle check takes the newest mtime among `BDMV/index.bdmv`, `BDMV/PLAYLIST/*`, `BDMV/CLIPINF/*` and `BDMV/STREAM/*`; for an ISO, the file's mtime.
  - An unsettled disc is skipped, and the cache keeps its previous entry if it had one.
  - Add an injectable `now` to `LibraryOptions`.
- [ ] **Step 4: Update `compose.yaml`.**
  - Add a bind for each drive that has a Downloads folder but no BDMVs root yet (its `/mnt/mediaN`), the same form as the others.
  - Append one `-dl` root per drive's Downloads folder, for example `media1-dl=/library-mnt/media1/Downloads@Downloads,media2-dl=/library-mnt/media2/Downloads@Downloads`, to `LIBRARY_ROOTS`.
  - Add `TMDB_API_KEY: ${TMDB_API_KEY:-}` and `TITLE_LIBRARY: owners` under `environment`, plus `env_file: [{ path: .env, required: false }]`.
- [ ] **Step 5: Run** the tests and `npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(server): scan the Downloads folders and skip discs still downloading`.

### Task 2: Disc evidence

**Files:**
- Create: `server/src/titles/evidence.ts`, `server/src/titles/evidence.test.ts`, `src/engine/disc/content-hash.ts`, `src/engine/disc/content-hash.test.ts`
- Modify: `server/src/library.ts` (it records evidence with each disc and caches it in `library.json`)

**Interfaces:**
- Produces in `src/engine/disc/content-hash.ts`: `contentHash(streams: readonly { name: string; size: number }[]): string | null`. This is TheDiscDB's ContentHash: the MD5 of each `.m2ts` size as an int64 little-endian, in name order (code-unit order of the upper-cased name), returned as uppercase hex. It returns null when there are no `.m2ts` files. It lives in `src/engine` so the client can use it later. Use a small MD5 written in TS; Node's `crypto` is not available to the engine.
- Produces in `server/src/titles/evidence.ts`:
  ```ts
  export interface DiscEvidence {
    readonly discId: string;
    readonly path: string;                 // root-relative, as DiscEntry.path
    readonly fingerprint: string | null;   // contentHash
    readonly discTitles: readonly { readonly lang: string; readonly name: string }[]; // bdmt di:name per language
    readonly segments: readonly string[];  // folder names from below the root down to the disc folder or ISO file name
    readonly catalogueNumbers: readonly string[];
    readonly playlists: readonly { readonly id: string; readonly durationS: number; readonly chapters: number; readonly clips: readonly string[] }[];
  }
  export function readFolderEvidence(entry: DiscEntry, dir: string): Promise<DiscEvidence>;
  export function readIsoEvidence(entry: DiscEntry, abs: string, tree: ReadonlyMap<string, UdfFile>): Promise<DiscEvidence>;
  export function catalogueNumbers(text: string): string[]; // e.g. 'ABCD-12345', 'MNOP 1357' → 'MNOP-1357', 'XXCL-1234~5' → 'XXCL-1234'
  ```
- Produces: `Library.evidence(): readonly DiscEvidence[]`, and `Library.onScanned(listener: () => void): void`, which fires after every completed scan.

- [ ] **Step 1: Write failing tests.**
  - `content-hash.test.ts` pins three vectors from TheDiscDB manifests:
    - `contentHash([{name:'00000.m2ts',size:1}])`, against the value computed by the reference C# algorithm and written into the test;
    - one real three-file manifest from `TheDiscDb/data`, with its sizes and hash copied into the test along with its manifest path in a comment;
    - empty → `null`.
  - `evidence.test.ts`, against a temp disc folder built with `tests/helpers` plus a `META/DL/bdmt_jpn.xml` and a `bdmt_eng.xml`:
    - `discTitles` holds both languages;
    - `segments` for `media1-dl/[BDMV][Foo][Vol.1-6 Fin]/Vol.3/BD` is `['[BDMV][Foo][Vol.1-6 Fin]', 'Vol.3', 'BD']`;
    - `playlists` lists each `.mpls` with its duration in seconds (from the play items' in/out times) and its chapter (entry mark) count.
  - `catalogueNumbers('[BDMV][240315][EFGH-6789][白い鳥の約束]')` → `['EFGH-6789']`.
  - An ISO case using `fixtures/synthetic/disc1.iso`.
- [ ] **Step 2: Run** `npx vitest run src/engine/disc/content-hash.test.ts server/src/titles/evidence.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Parse bdmt with a small tag reader (no XML dependency): `<di:name>` per file, with the language from the file name.
  - Playlists use `src/engine/bdmv/mpls-parser.ts`.
  - The library reads evidence once per new or changed disc (an unchanged disc keeps its cached evidence, the same as sizes), at the scan's existing pacing.
  - Record `content-hash.ts`'s algorithm source (TheDiscDb/web `HashingExtensions.cs`, MIT) in `src/engine/NOTICE`.
- [ ] **Step 4: Run** the tests and `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): record disc evidence during the scan`.

### Task 3: Name parsing and title text

**Files:**
- Create: `src/engine/disc/title-text.ts`, `src/engine/disc/title-text.test.ts`, `server/src/titles/parse-name.ts`, `server/src/titles/parse-name.test.ts`, `server/src/titles/corpus.ts` (the committed synthetic corpus), `tests/local/library-parse.test.ts` (skips without `fixtures/local/library-paths.txt`)

**Interfaces:**
- Produces in `title-text.ts`, shared by the server's matcher and the client's search:
  - `normalizeTitle(text: string): string`: NFKC, lower case, punctuation and spaces removed, long vowels folded (`ō→o`, `ū→u`, `ou→o`, `oo→o`, `uu→u`), katakana folded to hiragana.
  - `titleMatches(query: string, names: readonly string[]): boolean`: true when the normalised query is a substring of a normalised name.
- Produces in `parse-name.ts`:
  ```ts
  export interface ParsedName {
    readonly candidates: readonly string[]; // title strings left after stripping, best first; `English (日本語)` gives both
    readonly season: number | null;
    readonly volume: number | null;          // Vol./Volume/巻/上巻=1/下巻=2
    readonly disc: number | null;            // Disc/D/DISC
    readonly box: number | null;
    readonly year: number | null;
    readonly episodes: readonly [number, number] | null;
    readonly bonus: boolean;
    readonly music: boolean;                 // [CD] or FLAC together with BDMV, or an artist – title pattern under a Music folder
  }
  export function parseName(text: string): ParsedName;
  ```

- [ ] **Step 1: Write failing tests.**
  - `title-text.test.ts`:
    - `normalizeTitle('Hoshifuri no Tabibito') === normalizeTitle('hōshifurī no tabibito')` is false; romaji isn't transliterated.
    - `normalizeTitle('Hoshifuri no Tabibito') === 'hoshifurinotabibito'`.
    - `normalizeTitle('ヴェルミナ') === normalizeTitle('ゔぇるみな')`.
    - `titleMatches('starfall', ["Starfall Wanderer"])` is true.
    - `titleMatches('星降り', ['星降りの旅人'])` is true.
  - `parse-name.test.ts`, table-driven over `corpus.ts`. Each entry is `{ text, expected: Partial<ParsedName> }` and covers spec §3's styles. It includes at least:
    - `[BDMV][220629][Kumo no Ue no Tenshi][Vol.4]` → candidates[0] `Kumo no Ue no Tenshi`, volume 4;
    - `Ink.and.Iron.S05.1080p.JPN.Blu-ray.AVC.LPCM.2.0-GRP` → `Ink and Iron`, season 5;
    - `Starfall Wanderer (星降りの旅人)` → both candidates;
    - `月影の教室 2nd Season VOL.1` → season 2, volume 1;
    - `盤上の風 第8巻 DISC2` → volume 8, disc 2;
    - `Silent Archive Act.2 下巻` → volume 2;
    - `[BDMV][アニメ][140319] 鋼の城塞 Vol.9 特典DISC` → bonus true;
    - `[2025.03.26] 架空バンド - Morning Signal [CD][FLAC+CUE+LOG+BK+BDMV][XXCL-1234~5]` → music true;
    - `Lantern.Road.2025.2160p.USA.UHD.Blu-ray…` → year 2025;
    - `Spirit Blade Season 14 … (266-316)` → episodes [266, 316];
    - Review Focus 4: `第２期`, `Ｖｏｌ．３`, `ＤＩＳＣ２` parse as 2, 3 and 2.
- [ ] **Step 2: Run** `npx vitest run src/engine/disc/title-text.test.ts server/src/titles/parse-name.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The parser applies NFKC first, then strips bracketed tags, dates, resolutions, codecs, release groups and language or region tags, then reads the structure tokens from spec §7.
- [ ] **Step 4: Add the local test.** `tests/local/library-parse.test.ts` parses every line of `fixtures/local/library-paths.txt` and writes a summary (how many have a candidate, a season or a volume) to stdout. It asserts only that nothing throws.
- [ ] **Step 5: Run** the tests. Expected: PASS.
- [ ] **Step 6: Commit** `feat(server): parse disc and folder names into titles and structure`.

### Task 4: Metadata sources and the TheDiscDB index

**Files:**
- Create:
  - `server/src/titles/sources.ts` (shared types);
  - `server/src/titles/anilist.ts`, `server/src/titles/tmdb.ts`;
  - `server/src/titles/pacer.ts`;
  - `server/src/titles/discdb.ts`;
  - `scripts/build-discdb-index.ts`;
  - tests for each `.ts`, with recorded responses under `server/src/titles/__fixtures__/`.
- Modify: `server/Dockerfile` (copy `server/data/discdb-index.json` into the image), `server/build.mjs` (if needed), `server/NOTICE` (TheDiscDB MIT, TMDB attribution, AniList terms), `package.json` (`"discdb:index": "tsx scripts/build-discdb-index.ts"`), `.gitignore` (the clone directory `.cache/thediscdb`)

**Interfaces:**
- Produces in `sources.ts`:
  ```ts
  export type SourceName = 'anilist' | 'tmdb';
  export interface EntryNames { readonly english: string | null; readonly romaji: string | null; readonly native: string | null; readonly synonyms: readonly string[] }
  export interface Entry {
    readonly source: SourceName; readonly id: string;           // 'anilist:154587', 'tmdb-tv:65930', 'tmdb-movie:12345'
    readonly kind: 'series' | 'movie';
    readonly format: string | null;                             // AniList TV/TV_SHORT/MOVIE/OVA/ONA/SPECIAL
    readonly names: EntryNames; readonly year: number | null;
    readonly episodes: number | null; readonly runtimeMin: number | null;
    readonly seasons: readonly { readonly number: number; readonly episodes: number; readonly runtimeMin: number | null }[]; // TMDB TV only
    readonly relations: readonly { readonly type: string; readonly id: string; readonly format: string | null; readonly startDate: number | null }[]; // AniList only
    readonly poster: { readonly small: string; readonly large: string } | null; // source URLs
    readonly banner: string | null;
  }
  export interface MetadataSource {
    search(query: string, opts?: { year?: number; kind?: 'series' | 'movie' }): Promise<Entry[]>;
    entry(id: string): Promise<Entry | null>;
  }
  export class SourceUnavailable extends Error {} // network errors, 429 after retries, 5xx
  ```
- Produces: `createAniList(fetch: typeof globalThis.fetch, pacer: Pacer): MetadataSource` and `createTmdb(fetch, pacer, apiKey: string): MetadataSource`.
- Produces in `pacer.ts`: `class Pacer { constructor(perWindow: number, windowMs: number, now?: () => number, sleep?: (ms: number) => Promise<void>); run<T>(fn: () => Promise<T>): Promise<T> }`. AniList's pacer is `new Pacer(30, 60_000)`, TMDB's `new Pacer(20, 1_000)`. A `Retry-After` on a 429 waits that long once, then throws `SourceUnavailable`.
- Produces in `discdb.ts`: `interface DiscDbHit { readonly title: string; readonly year: number | null; readonly kind: 'series' | 'movie'; readonly tmdbId: string | null; readonly season: number | null; readonly episodes: readonly { readonly playlist: string; readonly season: number; readonly episode: number; readonly name: string | null }[] }` and `loadDiscDb(file: string): { lookup(fingerprint: string): DiscDbHit | null }`.

- [ ] **Step 1: Write failing tests.**
  - AniList, using one recorded GraphQL response for `search("Hoshifuri no Tabibito")` and one for `entry`:
    - names, format, episodes, duration, relations (SEQUEL/PREQUEL with format and start date), coverImage medium and large, and bannerImage are mapped;
    - the request body is a POST to `https://graphql.anilist.co` with `search` and `type: ANIME`.
  - TMDB, using recorded `search/tv`, `search/multi` and `tv/{id}` responses:
    - seasons with episode counts, `episode_run_time`, and poster URLs built as `https://image.tmdb.org/t/p/w185…` and `/w500…`;
    - the key is sent as `api_key` and never appears in a thrown error's message.
  - Pacer: with a fake clock, 31 calls in a minute run 30, then wait. A 429 with `Retry-After: 2` waits 2 s, retries once, and the second 429 throws `SourceUnavailable`.
  - discdb: a two-entry index file gives hits for both fingerprints and null for another.
- [ ] **Step 2: Run** the new tests. Expected: FAIL.
- [ ] **Step 3: Implement** the clients, the pacer and the index loader.
- [ ] **Step 4: Write the index script.** `scripts/build-discdb-index.ts`:
  - makes a sparse, shallow clone of `https://github.com/TheDiscDb/data` into `.cache/thediscdb`, with JSON files only (`git sparse-checkout set --no-cone '/**/*.json'`);
  - reads each disc JSON's ContentHash, title, year, type, TMDB id and per-title season and episode with its `.mpls`;
  - writes `server/data/discdb-index.json` (about 2 MB, committed).

  Run it once and commit the output. Record the source commit in the JSON's `source` field.
- [ ] **Step 5: Run** the tests and `npm run server:build`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(server): AniList, TMDB and TheDiscDB sources`.

### Task 5: Cautious matching

**Files:**
- Create: `server/src/titles/match.ts`, `server/src/titles/match.test.ts`
- Modify: `src/engine/disc/nas-api.ts` (`UnsortedReason`, shared with the client)

**Interfaces:**
- Consumes: `DiscEvidence` (Task 2), `parseName` and `normalizeTitle` (Task 3), `MetadataSource`, `Entry`, `SourceUnavailable` and `loadDiscDb` (Task 4).
- Produces:
  ```ts
  // in src/engine/disc/nas-api.ts:
  export type UnsortedReason = 'no-title' | 'several-fit' | 'no-season' | 'episode-past-season' | 'no-disc-number' | 'sources-disagree' | 'source-unreachable';
  // in server/src/titles/match.ts:
  export type DiscMatch =
    | { readonly discId: string; readonly status: 'filed'; readonly entryId: string; readonly season: number | null; readonly disc: number | null; readonly bonus: boolean; readonly via: readonly ('disc-title' | 'folder' | 'discdb')[] }
    | { readonly discId: string; readonly status: 'music'; readonly group: string; readonly name: string }
    | { readonly discId: string; readonly status: 'unsorted'; readonly reason: UnsortedReason; readonly suggestions: readonly string[] }; // suggestions: entry ids, up to 3
  export interface MatchContext { readonly anilist: MetadataSource; readonly tmdb: MetadataSource | null; readonly discdb: { lookup(fp: string): DiscDbHit | null }; readonly cache: Map<string, Entry[]> }
  export function groupKey(e: DiscEvidence): string;                    // the parent folder path of the disc folder or ISO
  export function matchDiscs(evidence: readonly DiscEvidence[], ctx: MatchContext): Promise<{ matches: DiscMatch[]; entries: Map<string, Entry> }>;
  ```

- [ ] **Step 1: Write failing tests.** Use fake `MetadataSource`s that return fixed entries per query. Each test names its rule:
  - One AniList entry fits, and both the disc title and the folder agree → `filed`, with season from the entry and disc from the volume.
  - Two entries fit equally (`Brasswick` → `Brasswick Season 2` (AniList) and `Brasswick (2019)` (TMDB movie)) → `unsorted`, `several-fit`, with both ids in the suggestions.
  - A TMDB TV match with 3 seasons and no season number in the evidence → `no-season`. The same with a single-season series → `filed`.
  - Episode range `[第13話]` on a season with 12 episodes → `episode-past-season`.
  - A group of 6 sibling discs with no volume numbers, matching an entry, where the release disc count is unknown → `no-disc-number`. The same group, with the parent folder saying `Vol.1-6 Fin` → `filed`, numbered in folder order.
  - A TheDiscDB hit that names a different title from the folder's only candidate → `sources-disagree`.
  - `BRASSWICK S02/BRASSWICK S02 VOL.2` and a sibling disc with no title inherit the group's entry.
  - **Review Focus 1:** a disc with only an `ita` bdmt `Ember Blade: Hinokiri no Ken` and folder `[BDMV] Hinokiri no Ken [Dist][ITA]` files under the same AniList entry as the Japanese release, or goes to Unsorted. It never files under an unrelated entry. Assert it isn't any id other than the expected one.
  - Under `.../Music/...` or with `parseName(...).music` → `music`, grouped by release folder and named after it.
  - A bonus marker with a resolved title → `filed` with `bonus: true`.
  - `anilist.search` throws `SourceUnavailable` → that group is `unsorted`, `source-unreachable`, and other groups still match.
  - Each group calls `search` at most once per candidate, so the cache prevents repeat calls.
- [ ] **Step 2: Run** `npx vitest run server/src/titles/match.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement spec §7's acceptance rules 1–4.**
  - Japanese-looking evidence (kana or kanji in a disc title or segment, `[BDMV]`, `JPN`) queries AniList first, everything else TMDB first, falling back to the other.
  - Candidate strings come from `parseName` over disc titles first, then segments from the disc upward.
  - The scoring is yours, but "comes close" must be defined as a constant with a comment, and a tie always means Unsorted.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): match disc groups cautiously against AniList, TMDB and TheDiscDB`.

### Task 6: Owner choices, own titles and the gate setting

**Files:**
- Create: `server/src/titles/owner-store.ts`, `server/src/titles/owner-store.test.ts`
- Modify: `src/engine/disc/nas-api.ts` (shared types below)

**Interfaces:**
- Produces in `nas-api.ts`:
  ```ts
  export type OwnerChoice =
    | { readonly kind: 'title'; readonly titleId: string; readonly season: number | null; readonly disc: number | null }
    | { readonly kind: 'music'; readonly name: string | null }
    | { readonly kind: 'extras'; readonly titleId: string; readonly season: number | null }
    | { readonly kind: 'hidden' };
  export interface OwnTitle { readonly id: string; readonly kind: TitleKind; readonly name: string; readonly seasons: number | null }
  export interface UnsortedItem { readonly discId: string; readonly path: string; readonly discTitles: readonly { readonly lang: string; readonly name: string }[]; readonly reason: UnsortedReason; readonly suggestions: readonly TitleSummary[]; readonly catalogueNumber: string | null; readonly group: string; readonly groupSize: number }
  ```
  `UnsortedReason` comes from Task 5. `UnsortedItem` and `OwnTitle` use `TitleKind`, `TitleNames` and `TitleSummary`, so add those to `nas-api.ts` in this task, exactly as Task 7 lists them.
- Produces in `owner-store.ts`:
  ```ts
  export interface OwnerSnapshot { readonly choices: ReadonlyMap<string, OwnerChoice>; readonly ownTitles: readonly OwnTitle[]; readonly displayNames: ReadonlyMap<string, string>; readonly gate: 'owners' | 'everyone' | null }
  export class OwnerStore {
    constructor(dir: string);
    snapshot(): OwnerSnapshot;
    setChoice(discId: string, fingerprint: string | null, choice: OwnerChoice): void;
    clearChoice(discId: string): void;
    setDisplayName(id: string, name: string | null): void;           // disc id or music title id
    createTitle(kind: TitleKind, name: string, seasons: number | null): OwnTitle;
    updateTitle(id: string, change: { name?: string; seasons?: number | null }): OwnTitle;
    deleteTitle(id: string): void;                                    // also clears every choice naming it
    setGate(gate: 'owners' | 'everyone'): void;
    reattach(discs: readonly { id: string; fingerprint: string | null }[]): void; // follow moved discs
  }
  ```
  Use the same atomic write and lock as `server/src/store.ts`'s `Store.update` (extract a shared helper if that keeps both short). The file is `owner.json`.

- [ ] **Step 1: Write failing tests.**
  - A choice set and read back survives a new `OwnerStore` on the same dir.
  - **Review Focus 3:** with a choice on disc `A` (fingerprint `F`), `reattach([{id:'B',fingerprint:'F'}])`, where `A` is absent, moves the choice to `B`. With `B` and `C` both carrying `F`, both get it. A choice whose disc has a null fingerprint stays under its id while that disc is absent.
  - `deleteTitle` removes the choices naming it, so those discs return to Unsorted in the catalogue.
  - `setGate('everyone')` persists, and `snapshot().gate` is `'everyone'`.
  - A corrupt `owner.json` throws an error naming the file, like `Store`.
- [ ] **Step 2: Run** `npx vitest run server/src/titles/owner-store.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Store choices as `{ [discId]: { choice, fingerprint } }`. `reattach` runs after each scan, before the catalogue is built.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): keep owner choices, own titles and the library gate`.

### Task 7: Catalogue: series, seasons, copies and episodes

**Files:**
- Create: `server/src/titles/catalogue.ts`, `server/src/titles/catalogue.test.ts`, `server/src/titles/episodes.ts`, `server/src/titles/episodes.test.ts`
- Modify: `src/engine/disc/nas-api.ts` (shared response types)

**Interfaces:**
- Produces in `nas-api.ts` (`TitleKind`, `TitleNames` and `TitleSummary` already exist from Task 6):
  ```ts
  export type TitleKind = 'series' | 'movie' | 'music';
  export interface TitleNames { readonly english: string | null; readonly romaji: string | null; readonly native: string | null; readonly synonyms: readonly string[]; readonly display: string | null }
  export interface TitleSummary { readonly id: string; readonly kind: TitleKind; readonly names: TitleNames; readonly poster: string | null; readonly year: number | null; readonly seasons: number; readonly discs: number; readonly addedAt: number; readonly own: boolean }
  export interface DiscRef { readonly discId: string; readonly root: string; readonly folder: string; readonly displayName: string | null }
  export interface DiscSlot { readonly number: number | null; readonly label: string; readonly copies: readonly DiscRef[] }
  export interface EpisodeRef { readonly number: number; readonly name: string | null; readonly runtimeMin: number | null; readonly discId: string; readonly playlistId: string }
  export interface SeasonDetail { readonly id: string; readonly label: string; readonly number: number | null; readonly discs: readonly DiscSlot[]; readonly episodes: readonly EpisodeRef[] | null; readonly extras: readonly DiscSlot[] }
  export interface TitleDetail { readonly title: TitleSummary; readonly banner: string | null; readonly seasons: readonly SeasonDetail[]; readonly related: readonly TitleSummary[]; readonly extras: readonly DiscSlot[] }
  ```
  - A movie's or music title's discs are one `SeasonDetail` with `number: null` and label `''`.
  - `poster` and `banner` are art ids for `GET art/<id>`, never source URLs.
- Produces in `episodes.ts`: `guessEpisodes(season: { episodes: number | null; runtimeMin: number | null }, discs: readonly { discId: string; playlists: DiscEvidence['playlists'] }[], firstNumber: number): EpisodeRef[] | null`.
- Produces in `catalogue.ts`: `buildCatalogue(input: { matches: readonly DiscMatch[]; entries: ReadonlyMap<string, Entry>; evidence: readonly DiscEvidence[]; owner: OwnerSnapshot; discdb: { lookup(fp: string): DiscDbHit | null }; addedAt: ReadonlyMap<string, number> }): Catalogue`, where:
  ```ts
  export interface Catalogue { readonly titles: readonly TitleSummary[]; detail(id: string): TitleDetail | null; readonly unsorted: readonly UnsortedItem[]; readonly hidden: readonly DiscRef[]; art(id: string): { small: string; large: string } | null }
  ```
  `UnsortedItem` and `OwnerSnapshot` come from Task 6.

- [ ] **Step 1: Write failing tests.**
  - `episodes.test.ts`:
    - a disc with playlists of 24, 24, 24, 72 (play-all) and 1.5 minutes, on a season with runtime 24 and 12 episodes, gives episodes 1–3 from the three 24-minute playlists;
    - two discs continue 4–6;
    - a total that doesn't equal 12 returns `null`;
    - duplicate playlists (the same clip list) count once.
  - `catalogue.test.ts`:
    - three AniList TV entries chained SEQUEL → SEQUEL form one series with seasons ordered by start date;
    - a related MOVIE appears in `related`;
    - a TMDB TV entry gives one series with its seasons;
    - two discs filed as season 5, disc 1 become one `DiscSlot` with two copies, ordered BDMVs root before a `-dl` root;
    - a TheDiscDB hit's episodes win over the guess;
    - a bonus disc with a known season lands in that season's `extras`, without a season in the title's `extras`;
    - music matches grouped by release folder become music titles;
    - an owner choice (Task 6) overrides a match;
    - a `hidden` choice removes the disc from every title and lists it in `hidden`;
    - an own title appears with `own: true` and no poster.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Title ids are stable: an AniList series is `anilist:<id of its first season>`, TMDB is `tmdb-tv:<id>` or `tmdb-movie:<id>`, music is `music:<hash of group>`, an own title is `own:<uuid>`.
  - A season's label is AniList's English or romaji name for that entry, or `Season N`.
  - Episode runtimes within ±25% of the season runtime count as episodes.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): build series, seasons, copies and episodes from matches`.

### Task 8: The title service, art cache and refresh

**Files:**
- Create: `server/src/titles/service.ts`, `server/src/titles/service.test.ts`, `server/src/titles/art.ts`, `server/src/titles/art.test.ts`
- Modify: `server/src/main.ts` (create the service and wire `library.onScanned`), `server/src/config.ts` (`tmdbApiKey: string | null`, `titleLibrary: 'owners' | 'everyone'`)

**Interfaces:**
- Produces:
  ```ts
  export interface TitleStatus { readonly running: boolean; readonly groupsDone: number; readonly groupsTotal: number; readonly filed: number; readonly unsorted: number; readonly music: number; readonly lastRunAt: number | null; readonly tmdb: boolean }
  export class TitleService {
    constructor(opts: { library: Library; owner: OwnerStore; dataDir: string; anilist: MetadataSource; tmdb: MetadataSource | null; discdb: { lookup(fp: string): DiscDbHit | null }; art: ArtCache; now?: () => number; setTimer?: (fn: () => void, ms: number) => () => void });
    catalogue(): Catalogue;              // the last built; served while a run is going
    status(): TitleStatus;
    runNow(): Promise<void>;             // after a scan; re-matches new or changed discs only, plus Unsorted when the weekly retry is due
    gate(): 'owners' | 'everyone';       // the owner's setting, else config
  }
  export class ArtCache { constructor(dir: string, fetch: typeof globalThis.fetch, budgetBytes?: number); get(artId: string, size: 'small' | 'large', url: string): Promise<{ path: string; type: string } | null> }
  ```
- Persists `metadata.json` in the data dir: matches, entries, per-disc evidence keys and each disc id's first-seen time (the catalogue's `addedAt`), so that a restart serves the last catalogue without network access.
- Refresh schedule: match after every scan; retry Unsorted weekly; refresh entries older than 30 days monthly.

- [ ] **Step 1: Write failing tests.**
  - `service.test.ts`, with fake sources, a temp dir and an injected clock:
    - after `runNow`, `catalogue().titles` holds the matched titles, and `metadata.json` exists;
    - a new service on the same dir serves the same catalogue before any run, and makes no source calls;
    - a second `runNow` with unchanged evidence makes 0 source calls;
    - **Review Focus 2:** a run where `anilist.search` throws `SourceUnavailable` keeps every previously filed disc filed, marks only the affected new groups `source-unreachable`, and the next run retries them;
    - `status()` counts groups during a run;
    - a disc's `addedAt` is its first-seen time and doesn't change on later runs.
  - `art.test.ts`:
    - a fetched image is stored under `art/<artId>-<size>` with its content type;
    - a second `get` doesn't fetch;
    - past the budget, the least recently used files are deleted;
    - a fetch failure returns null.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement**, and wire it in `main.ts`: `new TitleService(...)`, `library.onScanned(() => void service.runNow())`. `TMDB_API_KEY` absent means `tmdb: null`, and the server logs once "TMDB key not set: non-anime discs go to Unsorted".
- [ ] **Step 4: Run** the tests and `npm run server:build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): run matching after scans, cache art and refresh on a schedule`.

### Task 9: Title and owner routes

**Files:**
- Create: `server/src/routes/titles.ts`, `server/src/routes/titles.test.ts`
- Modify: `server/src/routes/admin.ts` (new owner routes), `server/src/app.ts` (register), `server/src/auth.ts` (if needed, so that `verify` returns `owner` for query-token requests too)

**Interfaces:**
- Consumes: `TitleService`, `OwnerStore`, `Catalogue` and the `nas-api` types.
- Produces these routes, under the existing token guard and CORS. Response shapes are the `nas-api` types.
  - `GET /api/titles` → `{ titles: TitleSummary[] }`
  - `GET /api/titles/<id>` → `TitleDetail` | 404
  - `GET /api/art/<artId>?size=small|large&t=` → the image, with `Cache-Control: private, max-age=2592000, immutable` and the step 2 CORP header
  - Owner only, in `admin.ts`:
    - `GET admin/unsorted?offset&limit` → `{ items: UnsortedItem[], total }`
    - `GET admin/hidden` → `{ discs: DiscRef[] }`
    - `GET admin/lookup?q&source=anilist|tmdb|own` → `{ titles: TitleSummary[] }`
    - `PUT admin/discs/<id>/choice` (body `{ choice: OwnerChoice, applyToGroup?: boolean }`) → 204
    - `DELETE admin/discs/<id>/choice` → 204
    - `PUT admin/names/<id>` (body `{ name: string | null }`) → 204
    - `POST admin/titles` (body `{ kind, name, seasons }`) → `OwnTitle`
    - `PATCH admin/titles/<id>`, `DELETE admin/titles/<id>`
    - `PUT admin/settings/title-library` (body `{ gate: 'owners' | 'everyone' }`) → 204
    - `GET admin/metadata/status` → `TitleStatus`
  - `GET /api/me` → `{ owner: boolean, titleLibrary: boolean }`, so the app knows whether to show the library.

- [ ] **Step 1: Write failing tests.**
  - With the gate at `owners`: a guest token gets 404 on `titles`, `titles/<id>` and `art/<id>`, and an owner token gets 200. With the gate at `everyone`, a guest gets 200.
  - `PUT admin/discs/<id>/choice` with `applyToGroup: true` sets choices on the other discs in the group, numbered by their parsed order.
  - `admin/lookup?source=tmdb` with no TMDB key returns `{ titles: [] }` and 200.
  - Every new admin route returns 403 to a guest.
  - A bad body returns 400 with a fixed error string.
  - `GET /api/me` reports both flags.
- [ ] **Step 2: Run** `npx vitest run server/src/routes/titles.test.ts server/src/auth.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Register `titleRoutes(service)` after `libraryRoute` in `app.ts`. A choice change rebuilds the catalogue at once (no network calls).
- [ ] **Step 4: Run** the server tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): title, art and owner routes behind the library gate`.

### Task 10: Library, Series and Season screens

**Files:**
- Create:
  - `src/ui/nas/title-model.ts`, `src/ui/nas/title-model.test.ts`;
  - `src/ui/nas/TitleLibrary.tsx`, `src/ui/nas/SeriesScreen.tsx`, `src/ui/nas/SeasonScreen.tsx`;
  - `src/ui/nas/title-library.css`, or the styles where the existing NAS screens keep theirs.
- Modify:
  - `src/ui/nas/nas-client.ts` (`me()`, `titles()`, `title(id)`, `artUrl(artId, size)`);
  - `src/ui/LandingScreen.tsx` (opens the library when `me().titleLibrary`, else the folder browser);
  - `src/ui/nas/LibraryScreen.tsx` (reachable as "Browse by folder instead");
  - `src/ui/nas/Preflight.tsx` (an optional `playlistId`: after the engine reports the disc is ready, `controller.playPlaylist(playlistId)`);
  - `tests/e2e/nas-server.ts` (a stub metadata source: `METADATA_FIXTURE=<file>` serves recorded entries in place of AniList and TMDB);
  - `tests/e2e/nas.spec.ts`.

**Interfaces:**
- Consumes: the Task 9 routes and the `nas-api` types; `titleMatches` from Task 3.
- Produces in `title-model.ts`:
  - `searchTitles(titles: readonly TitleSummary[], query: string): TitleSummary[]`: all names plus display names, best first, with exact prefix matches before substring matches;
  - `shelf(titles, kind: TitleKind): TitleSummary[]`, A–Z by the displayed name;
  - `recentlyAdded(titles, n = 9)`;
  - `displayName(t: TitleSummary): string`, using display, then english, then romaji, then native;
  - `secondaryName(t): string | null`, the native name when it differs.

- [ ] **Step 1: Write failing tests.**
  - `title-model.test.ts`:
    - `searchTitles` finds Starfall Wanderer by `starfall`, `hoshifuri` and `星降り`;
    - `shelf('series')` is sorted and excludes movies and music;
    - `displayName` prefers `display`.
  - `nas.spec.ts`, with the stub metadata fixture and the synthetic discs placed in folders the stub matches:
    - an owner sees the Library with the shelves Series, Movies, Music and Unsorted;
    - typing in the search box filters;
    - opening a series shows its seasons;
    - opening a season shows the Episodes and Discs tabs;
    - tapping an episode starts playback (`data-state` `playing`), and the telemetry's playlist is the episode's;
    - "Browse by folder instead" opens the folder browser;
    - **Review Focus 5:** a guest device with the gate closed lands on the folder browser with no error notice. After the owner sets the gate to `everyone` through the API, the guest's next app load shows the Library.
- [ ] **Step 2: Run** `npx vitest run src/ui/nas/title-model.test.ts` and `npx playwright test tests/e2e/nas.spec.ts --project=chromium`. Expected: FAIL.
- [ ] **Step 3: Implement the screens as in mockups 1–3, with spec §2's words.**
  - Posters are lazy-loaded `<img>` with `artUrl`, and a placeholder with initials when there is none.
  - A season whose `episodes` is `null` shows only the Discs list, with no tabs.
  - Use `setFolder` from `tests/e2e/support.ts` for any folder pick in the tests.
- [ ] **Step 4: Run** the tests on chromium, firefox and webkit. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): browse the NAS by title`.

### Task 11: Owner screens: Unsorted, New title, Hidden, Music names and the gate

**Files:**
- Create: `src/ui/nas/UnsortedScreen.tsx`, `src/ui/nas/unsorted-model.ts`, `src/ui/nas/unsorted-model.test.ts`, `src/ui/nas/MusicScreen.tsx`, `src/ui/nas/HiddenScreen.tsx`
- Modify: `src/ui/nas/nas-client.ts` (the `admin` group gains the Task 9 owner routes), `src/ui/nas/AdminScreen.tsx` (the title library section: the gate switch, matching status, TMDB attribution), `tests/e2e/nas.spec.ts`

**Interfaces:**
- Consumes: the Task 9 owner routes.
- Produces in `unsorted-model.ts`:
  - `reasonText(reason: UnsortedReason): string`, using exactly these strings:

    | Reason | Text |
    |---|---|
    | `no-title` | "No title found" |
    | `several-fit` | "More than one title fits" |
    | `no-season` | "No season number" |
    | `episode-past-season` | "Episode number is past the season's last" |
    | `no-disc-number` | "No disc number" |
    | `sources-disagree` | "The sources disagree" |
    | `source-unreachable` | "AniList or TMDB couldn't be reached; it will try again" |

  - `blurayComSearchUrl(catalogueNumber: string): string` → `https://www.blu-ray.com/search/?quicksearch=1&quicksearch_keyword=<encoded>&section=bluraymovies`.

- [ ] **Step 1: Write failing tests.**
  - `unsorted-model.test.ts`: every reason has text, and the Blu-ray.com URL encodes the catalogue number.
  - `nas.spec.ts`, as an owner with the stub fixture:
    - Unsorted lists a disc with its reason;
    - picking a suggestion and "File it" moves it into the series;
    - "Apply to the other N discs in this folder" files its siblings;
    - "New title…" with kind Music and name `Live 2024` creates a title on the Music shelf;
    - "Don't list" moves a disc to Hidden, and "Unhide" brings it back;
    - renaming a music title shows the new name in the Music shelf and in search;
    - the NAS settings show the matching status and the TMDB attribution text verbatim;
    - switching the gate to "Everyone" calls `PUT admin/settings/title-library`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** the screens as in mockups 4 and 5.
  - The gate switch reads "Show the title library to everyone", off by default, with a confirm step.
  - Touch targets are at least 44 px.
- [ ] **Step 4: Run** the unit tests and `tests/e2e/nas.spec.ts` on all three projects. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): file Unsorted discs, own titles, hidden discs and music names`.

### Task 12: Deploy, match the real library, spot-check, docs

This is the controller's stop point. It needs the user's approval for the merge, the push and the deploy, and the user's TMDB key and spot-check.

**Files:**
- Modify: `CLAUDE.md` (title library architecture and commands), `docs/known-issues.md`, the spec's Status line

- [ ] **Step 1: Ask the user** to approve merging and pushing, and deploying the NAS with the gate at `owners`. Ask for their TMDB API key, which goes into `~/bluray-server/.env` on the NAS as `TMDB_API_KEY=...`; never echo it.
- [ ] **Step 2: Deploy** with `npm run server:deploy`. Check:
  - health, and that the other Caddy sites are unaffected;
  - the cold scan of both trees, timed;
  - the matching run's progress at `GET admin/metadata/status`, with its duration recorded;
  - `docker exec bluray-server touch /library-mnt/media1/x`, which must fail (read-only; carried from the step 2 review, N1).
- [ ] **Step 3: Write the match report** for the user:
  - filed, Unsorted by reason, Music, extras;
  - 50 filed discs drawn at random (their path, then the title, season and disc they were filed under), as a private page or file.

  The user checks the sample.
- [ ] **Step 4: If any of the 50 is wrong,** tighten the acceptance rule that let it through (with a unit test from that case), redeploy and rerun, then draw a new sample. The bar is 0 wrong out of 50.
- [ ] **Step 5: When the user approves,** they switch the gate to Everyone from NAS settings, or I do it with their approval.
- [ ] **Step 6: Docs.**
  - `CLAUDE.md`: the title library architecture, `npm run discdb:index`, and `fixtures/local/library-paths.txt`.
  - Known issues: the TheDiscDB coverage numbers, the episode guess limits, and AniList's rate limit.
  - The spec's Status: done, with the report's numbers.
- [ ] **Step 7: Commit** `docs: title library deployed and spot-checked`.
