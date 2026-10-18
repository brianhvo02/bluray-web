# NAS Library by Title (Step 2, part 2) — Design Spec

Date: 2026-10-17
Status: Deployed 2026-10-18 with the gate at owners; matching on the real library in progress (2,349 discs, after adding the Downloads and Rips folders); spot-check pending.
Parent spec: `2026-10-17-nas-server-design.md` (step 2). This document adds a title library on top of step 2's server and folder browser. Where the two disagree, this one wins for the library.

## 1. Intent

The user looks for "a particular season of a show, or a particular movie". They want to find it by its title, then pick the season or movie, then play. Today the app shows the drives' folder tree, which only works if you remember where a disc sits and what its folder is called. The folder names are a mix of the user's tidy layout, Japanese release names, scene names and bare disc labels.

Success: on the iPhone, the user (or a family member) types "starfall", "hoshifuri" or "星降り" and gets one series. Tapping it shows its seasons and movies. Tapping a season shows its episodes and its discs. Tapping an episode plays it. Discs the NAS could not identify with confidence sit in an owner-only Unsorted pile, which the user files by hand once. No disc is ever filed wrongly with confidence.

## 2. Vocabulary

These words are used in the UI and in this document (the user asked for terms that cover movies, series and music alike):

- **Title**: anything the library lists. It is one of three kinds:
  - **Series**: a TV or anime series, made of **seasons**, with **episodes** in them. "Series" rather than "show", so it doesn't clash with a live show.
  - **Movie**: one film, which may span several discs.
  - **Music**: a concert, live show, music video collection or CD bonus disc. It may have several discs.
- **Disc**: one Blu-ray folder or ISO on the NAS. A title's discs may be spread over drives and folders.
- **Copy**: the same disc found twice, for example a Japanese release and a scene rip of the same volume.
- **Extras**: bonus discs. A season's extras sit with that season; a title's extras sit with the title when no season is known.
- **Shelves**: Series, Movies, Music, and Unsorted (owners only).
- **Own title**: a title the owner creates and names because AniList and TMDB don't have it.

## 3. The library as it is (recon, 2026-10-17, read-only)

- **Disc counts.** 2,456 discs:
  - 795 under the seven `/mnt/drvN/BDMVs` roots that step 2 already scans.
  - 1,661 under the drives' `Downloads` folders, which nothing scans today: drv0 183, drv1 75, drv2 250, drv3 520, drv4 633, drv8 none.
  - 183 of the 2,456 are ISOs. drv1 and drv4 are not mounted into the container today.
- **Discs carry their own titles.** 1,963 of the 2,456 (80%) have `BDMV/META/DL/bdmt_<lang>.xml`. Japanese appears on 1,509, English on 935, others rarely. Its `di:name` holds a title plus a volume or disc number: `星降りの旅人 2`, `Deep Orbit: Frontier Season 2 Disc 2`, `月影の教室 2nd Season VOL.1`, `KAZEGURUMA Blu-ray Box Season3 Disc3`.
- **Folder name styles** (classified by a heuristic):

  | Style | Discs | Example |
  |---|---|---|
  | Japanese release | ~1,220 | `[BDMV][220629][Kumo no Ue no Tenshi][Vol.4]`, `[BDMV][アニメ][青い硝子の庭][Vol.1-Vol.12 Fin]/…Vol.3` |
  | The user's tidy layout | ~370 | `Starfall Wanderer (星降りの旅人)/Volume 2`, `Kazeguruma (風車)/Season 3/Disc 7` |
  | Scene | ~300 | `Ink.and.Iron.S05.1080p.JPN.Blu-ray.AVC.LPCM.2.0-GRP/BDROM_22`, `Lantern.Road.2025.2160p…` |
  | Loose | ~420, 190 of them without a disc title | `BRASSWICK S02/BRASSWICK S02 VOL.2`, `夏の終わりの灯台/BD`, `Harbor Line 7/HARBOR_L7_02` |

  Seasons, volumes and box sets nest up to six levels.
- **Music.** 72 music Blu-rays (concerts, live shows, CD bonus discs), all in `drv1/Downloads/Music`.
- **Bonus discs.** About 60 bonus or special discs (`[Bonus] Volume 3`, `特典DISC`, `Reading&Live Event`).
- **Catalogue numbers.** Many folders carry the release's catalogue number (`ABCD-12345`, `EFGH-6789`, `IJKL-24680`, `MNOP 1357`).
- **Duplicates.** The same volume exists twice in places, for example a scene copy and a Japanese release copy, or an Italian release.
- **TheDiscDB** (MIT; `github.com/TheDiscDb/data`).
  - Coverage: it knows 152 of the 2,273 folder discs (6.7%), and 0 real Japanese releases; the ISOs were not checked. 115 of the matches map playlists to episodes, mostly Western TV sets.
  - Disc key: its "ContentHash" is the MD5 of the sizes of `BDMV/STREAM/*.m2ts` in file-name order, each as an int64 little-endian, in uppercase hex. Only exact pressings match.
  - Size: the data repo is 425 MB as a sparse clone. The index built from it (hash to title, type, season, episodes) is 2.1 MB.
  - Caveat: a few records are mislabelled.
- **Blu-ray.com** has no public API, and its terms allow lookups by hand only, not bulk scraping.

## 4. Goals, non-goals, anti-goals

Goals:
- Browse and search by title: title → season, movie or extras → episode or disc. Search matches English, romaji and Japanese titles (user).
- Cover all discs: the BDMVs roots plus the Downloads folders of drv0–drv4 (user).
- **Cautious matching.** A disc is filed only when the title, the season, and the disc's place in it are unambiguous. Everything else goes to Unsorted (user).
- **Unsorted** is owner-only. The owner files a disc by picking a title, or by creating an own title (user), then a season and a disc number. The NAS keeps that choice for good. A rescan, a metadata refresh, or the disc moving to another folder never loses it (§9).
- **Season pages** show both episodes and discs (user). Two copies of one disc are both shown, labelled by drive and folder; the app doesn't pick one.
- **Music** titles are named by their folder, and the owner can give any of them a display name. The name is a value stored on the NAS; folders are never renamed (user).
- **Extras**: bonus discs sit with their season, or with the title when the season isn't clear (user).
- **Folder view** stays as a second way in (user).
- Titles and posters come from AniList (anime) and TMDB (everything else). The NAS fetches and caches them; phones never contact AniList or TMDB (user, mechanics my call).

Non-goals:
- Renaming or moving files or folders on the drives. The server stays read-only on the library mounts.
- Watch history, "continue watching", ratings, user lists, AniList account sync.
- DVD ISOs (the player is Blu-ray only, and the scan already skips them).
- Bulk use of Blu-ray.com. Only a per-disc "look it up" link is in scope.
- Matching from video content (fingerprinting frames or audio).
- Music databases (MusicBrainz and the like). Music titles are named by folder or by the owner.

Anti-goals:
- **A confident wrong match.** A disc under the wrong title or season is worse than one in Unsorted. When in doubt, Unsorted.
- **Losing the owner's manual work.** Choices, own titles and renames must survive rescans, metadata refreshes, discs moving between folders or drives, and server upgrades.
- **The library going blank when AniList, TMDB or the internet is unreachable.** The NAS serves what it already knows.
- **Hammering AniList or TMDB.** Stay well under their rate limits, cache results, and look up each folder group once rather than every disc.
- **Exposing the TMDB key to clients.**
- **Family seeing an unchecked library.** Until the owner signs off on the spot-check (§13), non-owner devices keep the folder view.

## 5. Decisions

| Question | Decision | By |
|---|---|---|
| Browse by | Title, then season, movie or extras, then episode or disc | User |
| Title languages | Search matches English, romaji and Japanese | User |
| Words | Title (Series, Movie, Music), season, episode, disc, copy, extras, shelf (§2) | User asked for umbrella terms; the words are my call |
| Uncertain discs | Unsorted, filed by the owner later | User |
| Matching stance | Cautious: more Unsorted rather than any wrong matches | User |
| Unknown to AniList/TMDB | The owner can create an own title (kind, name, optional seasons) | User |
| Season page | Episodes and discs as two tabs | User |
| Music | Music shelf, named by folder, renamable with a NAS-stored value | User |
| Bonus discs | Extras with the season, or with the title | User (confirmed my guess) |
| Folder view | Kept as a second way in | User |
| Downloads folders | Scanned: drv0–drv4 `Downloads` added as roots | User |
| Order | Step 2 as built (folder view) is deployed and the devices paired first. The title library follows, spot-checked owner-only, then turned on for everyone | User |
| Moved discs | Owner choices follow the disc by its content fingerprint | My call |
| Hiding a disc | Hidden from the title library only; owners can unhide from a Hidden list | My call |
| Metadata sources | AniList for anime, TMDB for the rest, TheDiscDB for exact episodes where it knows the disc | User asked for AniList/TMDB; TheDiscDB my call after measuring |
| Blu-ray.com | Only a "look up this catalogue number" link on Unsorted items | My call (terms) |
| Who matches | The NAS server, during and after the scan | My call |
| Look | Dark ground, amber accent, as in the mockups | My call |

Mockups (approved by the user): `https://claude.ai/artifact/JT3HaZAxQ1K4x7uTkSqYXf`. Five phone screens: Library, Series, Season, Unsorted and Music. Where a mockup and §2 differ, §2's words win.

## 6. Sources and roots

- **New roots in `LIBRARY_ROOTS`.** Add `drv0-dl=/library-mnt/drv0/Downloads` and the same for drv1–drv4 (names are the builder's; root names are the first segment of disc paths and IDs).
  - Mount `/mnt/drv1` and `/mnt/drv4` the same way as the others.
  - Existing roots and disc IDs don't change.
  - The folder view shows the Downloads roots as one top-level "Downloads" folder, merging the five, beside the BDMVs content. That needs a small change to the top-level merge, which today merges every root's children together.
- **Discs still downloading.** A disc whose files changed in the last hour is not added yet, and is picked up by a later scan. Use the newest mtime of `index.bdmv`, the `.mpls`/`.clpi` files and the `.m2ts` sizes and mtimes (my call).
- **Scan cost.** Downloads holds many non-disc files (FLAC, logs, scans), and the scan's existing pacing and skip rules apply. A cold scan of the larger tree on HDDs may take tens of minutes, and the cached tree is served meanwhile.

## 7. Identifying a disc

For every disc the scan records **evidence**, all cheap reads:
- every `bdmt_*.xml` `di:name`, with its language;
- the folder path segments from the root down;
- catalogue numbers found in those segments;
- the **content fingerprint**: the TheDiscDB ContentHash, from `BDMV/STREAM` names and sizes, or from the UDF tree for an ISO. It also keys owner choices (§9);
- the main playlists' durations and chapter counts, from the `.mpls`/`.clpi` files the manifest already reads.

**Name parsing** turns each folder segment and disc title into candidate titles plus structure:
- Strip tags: `[BDMV]`, `[アニメ]`, dates like `[220629]` or `[2025.03.26]`, resolution, codecs, release groups, region and language tags.
- Pull out structure:
  - season: `S02`, `Season 2`, `2nd Season`, `第2期`, `第2シリーズ`;
  - volume or disc: `Vol.3`, `VOL_3`, `Volume 2`, `Disc 7`, `D3`, `DISC2`, `第8巻`, `上巻`/`下巻`;
  - box: `BOX 2`, `Box 02`;
  - year: `(2024)`, `.2025.`;
  - episode ranges: `(266-316)`, `[第13話]`;
  - bonus markers: `Bonus`, `特典`, `映像特典`, `Event`, `Live`.
- Split the tidy layout's `English (日本語)` into two candidates.

The parser is original code with a test corpus (§12).

**Grouping before lookup.** Discs under the same parent folder, and the same box or series folder, form a group that is matched once. Each disc then inherits the group's title, unless its own evidence names a different one. This makes "loose" discs like `BRASSWICK S02/BRASSWICK S02 VOL.2` and `Harbor Line 7/HARBOR_L7_02` identifiable from their parents, and keeps lookups down to roughly one per group rather than one per disc.

**Lookup.**
- Anime candidates go to AniList (GraphQL, no key; search matches English, romaji and native titles).
- Others go to TMDB search: TV, then movie; a year narrows it.
- The choice of "anime" doesn't need to be decided up front. Query AniList first when the evidence has Japanese text, a Japanese release pattern or a Japanese label; otherwise query TMDB first. Fall back to the other.
- A TheDiscDB hit gives title, season and episodes directly. Treat it as strong evidence, not as proof (§3 caveat), so it still has to agree with the other evidence or stand unopposed.

**Cautious acceptance.** A group or disc is filed only when all of these hold:
1. Exactly one entry fits. Its title, in any language, matches a candidate after normalisation (§10), and no other entry comes close.
2. Two independent pieces of evidence agree (the disc title and a folder name, or folder and TheDiscDB), or one exact match has no competitor at all.
3. The season or movie is resolved:
   - On AniList, each season or part is its own entry, so (1) resolves it, provided the evidence's season number, if any, agrees with the entry's place in the franchise.
   - On TMDB, the season number comes from the evidence. A TV match without a season number is filed only when the series has a single season.
4. The disc's place is known: a volume or disc number, or its order among siblings in a group that matches the release's disc count.

Anything else goes to Unsorted with a **reason** the owner sees, for example "two AniList entries fit", "no season number", "episode 13 is past the season's 12", or "no title found". The exact scoring and thresholds are the builder's, tuned on the real library (§12). The bar is "the owner finds no wrong matches in a sample".

**Music.** A disc goes to the Music shelf, not to lookup, when it sits under a folder named `Music`, or when its name or tags show a CD-plus-BD release (`[CD]`, `FLAC`, `BDMV` together with an artist–title pattern). Discs in the same release folder form one music title, named after that folder. The owner can also move a disc to Music, or out of it.

**Extras.** A disc with a bonus marker whose title is resolved goes to that season's extras when the season is known, otherwise to the title's extras.

## 8. Titles, seasons and episodes

- **Series** (my call):
  - On AniList, a series is the chain of TV and TV_SHORT entries linked by SEQUEL/PREQUEL. Seasons are ordered by start date and named by AniList's title, with "Season N" as a fallback label. Movies, OVAs and ONAs related to the chain appear under the series as their own rows.
  - On TMDB, a series is the TV series with its seasons. A TMDB movie stands alone unless AniList ties it to a franchise.
  - Standalone movies are on the Movies shelf.
- **Disc order** within a season, movie or music title: by the parsed volume or disc number, then by folder order.
- **Episodes.**
  1. A TheDiscDB match gives each playlist's season and episode exactly.
  2. Otherwise, guess from playlists:
     - Episode-length titles (taken from the season's typical episode runtime in AniList or TMDB, ±25%) are numbered in disc order, continuing from the previous disc.
     - Play-all playlists (spanning others), very short ones (openings, endings, previews) and duplicates are excluded.
  3. If the guessed total doesn't equal the season's episode count, the season shows its discs only and hides the Episodes tab, rather than showing wrong numbers. The owner can still play any disc.
  4. Own titles and Music show discs only, with no Episodes tab.
  5. Playing an episode opens its disc at that playlist (`PlayerController` already opens a disc and starts a playlist).
- **Copies.** When two discs claim the same season and disc number, both are listed under that disc, labelled by drive and top folder. Episodes play from the first copy, ordered: BDMVs before Downloads, then by drive.

## 9. Owner choices, own titles and Unsorted

- **Owner choice.** Stored per disc. It is one of:
  - a title, plus season or movie, plus disc number;
  - "Music", with an optional display name;
  - "Extras of" a title or season;
  - "Don't list".

  Owner choices always beat automatic matching, and are kept even while the disc is missing.
- **Following a moved disc** (my call).
  - Each choice is stored under the disc ID and also under the disc's content fingerprint (§7).
  - When a disc ID disappears and a new disc with the same fingerprint appears (for example a finished download moved from `Downloads` into `BDMVs`, or a release folder tidied into the user's own layout), the choice moves to the new disc.
  - When several discs share one fingerprint, they are copies of the same disc, so the choice applies to all of them.
  - A disc without a fingerprint (no `STREAM` files) keeps its choice under its ID only.
- **Own titles.**
  - From Unsorted, "New title…" asks for a kind (Series, Movie or Music) and a name; a series also asks for the number of seasons.
  - An own title appears on its shelf and in search like any other, with no poster (a placeholder with its initials). The owner can rename it or delete it; deleting returns its discs to Unsorted.
  - Own titles are stored on the NAS with the owner choices.
- **Filing a group.** Filing one disc of a group offers "apply to the other N discs in this folder", numbered by their parsed order, so a box set is filed in one go.
- **The Unsorted screen** shows, per disc:
  - the reason, the folder path and the disc's own title;
  - up to three suggestions, then a search box (AniList and TMDB through the NAS, plus own titles);
  - "New title…";
  - season and disc number fields, "File it", "Mark as Music", "Don't list" and Skip;
  - when a catalogue number was found, a "Look up `<number>` on Blu-ray.com" link that opens Blu-ray.com's search in a new tab.
- **Hidden.** A "Don't list" disc is left out of the title library for everyone, owners included. It stays in the folder view. Owners have a Hidden list (from the Unsorted shelf) to undo it.
- **Display names.** The owner can set one on any music title or disc, shown in place of the folder name. "Use folder name" removes it.

## 10. Search

- The client fetches the whole title list once per session (about 1,000 titles, each with all their names; small) and searches locally as you type.
- **Normalisation** (my call):
  - NFKC, case-folding and punctuation removal;
  - long vowels folded (`ō`→`o`, `ou`/`oo`/`uu` collapsed);
  - katakana ↔ hiragana folding;
  - a match on any of the English, romaji, native and synonym names.
- Own titles, music display names and disc display names are searchable too.

## 11. Server, data and API

- **Storage** in `/data`:
  - `metadata.json`: entries, titles and per-disc matches with their evidence and reasons;
  - `owner.json`: owner choices, own titles and display names;
  - `art/`: cached posters and banners, resized to two widths, with a budget of about 500 MB.

  Written atomically like the existing state files. The format and the split are the builder's.
- **Refresh.**
  - New and changed discs are matched after each scan.
  - Unsorted is retried weekly.
  - Matched entries are refreshed monthly for names and art.
  - Requests are paced: AniList at most 30 per minute, as its limit has been lowered at times; TMDB at most 20 per second.
  - Results are cached so a rescan makes no requests for unchanged discs.
  - The first full run (about 1,000 groups) may take about an hour in the background. The owner's screens show its progress.
- **TheDiscDB index.**
  - A repo script builds the compact index (hash to title, season, episodes) from a sparse clone of `TheDiscDb/data`.
  - The image bundles the index, refreshed on each deploy.
  - Record its MIT licence in `server/NOTICE`.
- **TMDB key.**
  - The user creates a free TMDB account and API key.
  - The key lives in the NAS's `~/bluray-server/.env`, read by compose as `TMDB_API_KEY`. It is never committed, and never sent to clients.
  - Without a key the NAS uses AniList and TheDiscDB only, and non-anime discs go to Unsorted.
- **Release gate.**
  - A server setting, `TITLE_LIBRARY=owners|everyone` (default `owners`), says who gets the title endpoints. Non-owners get 404 from them, and their app stays on the folder view.
  - The owner switches the setting to `everyone` from NAS settings once the spot-check passes (§13). It is stored in `/data`; the env value is only the default.
- **API** (under `/bluray/api/`, same auth and CORS rules as step 2):
  - `GET titles` → every title, with its kind, names in all languages, poster ids and counts. The client caches it for the session.
  - `GET titles/<id>` → a title's seasons, movies and extras. Each season has its discs: id, label, copies with drive and folder. It also has episodes when known: number, name, runtime, disc id, playlist.
  - `GET art/<id>?w=<width>&t=<token>` → a cached image, with the same CORP header and immutable caching.
  - Owner only:
    - `GET admin/unsorted` (paged, with reasons and suggestions) and `GET admin/hidden`;
    - `GET admin/lookup?q=&source=anilist|tmdb|own` (searches through the NAS);
    - `PUT admin/discs/<id>/choice`, `DELETE admin/discs/<id>/choice`;
    - `POST admin/titles`, `PATCH admin/titles/<id>`, `DELETE admin/titles/<id>` (own titles);
    - `PUT admin/settings/title-library`;
    - `GET admin/metadata/status` (the matching run's progress).
  - `GET library?path=` (the folder view) stays as is, apart from the Downloads merge (§6).
- **Attribution.**
  - TMDB requires its notice ("This product uses the TMDB API but is not endorsed or certified by TMDB") and logo where its data appears. Put them in the app's NAS settings or about screen, and in `server/NOTICE`.
  - AniList's terms (non-commercial use, rate limits) are checked at build time and recorded the same way.

## 12. Testing

- **Name-parser corpus.** A committed set of synthetic folder paths and disc titles covering every style in §3, with the expected candidates and structure.
  - The real library listing stays out of the public repo (my call). A gitignored `fixtures/local/library-paths.txt`, plus a local test that runs the parser and matcher over it, lets the developer measure on the real data, the same way `tests/local` does for discs.
- **Matcher unit tests** with recorded AniList, TMDB and TheDiscDB responses: cautious acceptance, every Unsorted reason, group inheritance, copies, extras, music, owner choices beating matches.
- **Owner-choice tests:**
  - a choice follows a disc moved to a new ID with the same fingerprint;
  - copies sharing a fingerprint all take the choice;
  - deleting an own title returns its discs to Unsorted;
  - "Don't list" hides a disc from titles but not from the folder view.
- **Episode guess tests** on synthetic playlists: play-all and opening/ending playlists are excluded, and a mismatched count hides the Episodes tab.
- **E2E**, against the step 2 harness with a stubbed metadata source:
  - search in all three scripts;
  - series, season, episode play;
  - an owner files an Unsorted disc, and creates an own title;
  - Music rename;
  - a guest sees only the folder view until the gate is opened, then the library;
  - the folder view still works.

## 13. Order of work and release

1. **Before the library work** (agreed with the user):
   - fix the Firefox CI failure and get main's deploys green;
   - redeploy the NAS with step 2 as built (folder view);
   - pair the user's iPad, iPhone and Mac;
   - run the device run.
2. **Build the title library** on a branch.
3. **Deploy it** with the gate at `owners`. The user adds the TMDB key.
4. **Run matching on the real library.** The owner's screens show a report:
   - filed, Unsorted by reason, Music, Extras;
   - a random sample of 50 filed discs, which the user checks.

   The bar is no wrong match in the sample. If one is wrong, tighten the acceptance rules, redeploy and rerun. The plan's final task owns this.
5. **The owner turns the gate to `everyone`.**

## 14. Client

- For owners, and for everyone once the gate is open, the NAS landing screen opens on the **Library** (mockup 1): search, shelves (Series, Movies, Music, and Unsorted for owners), recently added, A–Z. "Browse by folder instead" leads to the step 2 folder browser. When the gate is closed for a guest, the landing screen stays on the folder browser.
- Then **Series** (2), **Season** (3, tabs Episodes and Discs), **Unsorted** (4, owners) and **Music** (5).
- Tapping a disc or episode goes through step 2's pre-flight and open path.
- Touch targets are at least 44 px, it works at phone width, and art is lazy-loaded at the size shown.
- Offline: titles and art the client already fetched may be shown from memory. No new offline storage in this step.

## 15. Out of scope

Everything in §4's non-goals, plus: automatic choice between copies by quality, cross-device watch state, and editing AniList or TMDB data.

## 16. Left to the builder

- Matching scores and thresholds, within §7's rules, tuned on the spot-check.
- The storage format and file split.
- Pacing details, and how the refresh schedule is implemented.
- How the series grouping handles odd AniList relation graphs (side stories, recaps). When unsure, list such an entry under the series as its own row, not as a season.
- The visual detail beyond the mockups.
