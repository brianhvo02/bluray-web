# README, documentation and licence: design

Status: design agreed in conversation 2026-10-22; not built.

## 1. Why

The README is a developer's command list (66 lines of build and test commands), there is no documentation for people
who play discs, the self-hosting guide is the only user-facing doc, and the repo has no top-level licence: the engine,
server and Worker are LGPL-2.1, the BD-J class library GPLv2 with the Classpath Exception, and everything else (the React
UI, the player shell) has no licence at all. The owner wants a README in the style of React's (facebook/react), with its
status badges, and documentation for players and self-hosters, readable both on GitHub and on the player's website.

## 2. Goals, non-goals, anti-goals

Goals:
- A top-level `LICENSE`: LGPL-2.1-or-later for every part that has no licence of its own (owner's call), with the
  existing exceptions kept and listed.
- A README shaped like React's: status badges first, then a short introduction, Get started, Documentation, Run your
  own server, Contributing, License.
- Documentation pages for players, plus the existing self-hosting guide, as Markdown in `docs/`.
- The same pages on the player's site under `/help`, built from the same Markdown files at build time.

Non-goals:
- Developer documentation beyond moving today's README commands into a contributing page (CLAUDE.md stays the
  developer reference).
- Translations, search, a separate documentation site or generator.
- A test-coverage badge (the owner wants status badges, as React has).

Anti-goals:
- Two copies of any page that can drift apart.
- Documentation that describes features the app doesn't have, or gets a setting, key or command wrong.
- Any of the owner's real addresses, hosts, titles or library names in the docs or screenshots (the repo is public).
- The help pages breaking the site's cross-origin isolation (COOP/COEP) or the offline service worker.

## 3. Decided

**Licence.** `LICENSE` at the repo root holds the full LGPL-2.1 text. The README's License section says: the project is
LGPL-2.1-or-later, except `src/bdj-classlib/` (GPLv2 with the Classpath Exception, with the Apache, SAX and ICU notices
its `NOTICE` lists) and `src/wasm/freetype/` (the FreeType License); the server image also contains jellyfin-ffmpeg
(GPL-3.0, see `server/deploy/IMAGE-NOTICE`). `package.json` gains `"license": "LGPL-2.1-or-later"`.

**Badges (owner's call: status badges, as React has).** In this order, each linking to its workflow's runs on main:
CI (`ci.yml`), WASM (`wasm.yml`), VM trace (`vm-trace.yml`), BD-J trace (`bdj-trace.yml`), BD-J class library
(`bdj-classlib.yml`), ASS trace (`ass-trace.yml`); then a licence badge (`LGPL-2.1-or-later`, shields.io static badge,
linking to `LICENSE`) and a "Try it" badge linking to https://bluray-web.pages.dev. Workflow badges use GitHub's own
`…/actions/workflows/<file>/badge.svg?branch=main`.

**README sections.**
1. Title and a three-sentence introduction (a Blu-ray player in the browser; plays decrypted disc folders with menus,
   subtitles and audio tracks; nothing is uploaded, and an optional NAS server streams a library).
2. Get started: open the site, pick a disc folder; or pair with a NAS. Supported browsers.
3. Documentation: links to each page in `docs/` (and that the same pages are on the site under `/help`).
4. Run your own server: two lines and a link to `docs/self-hosting.md`.
5. Contributing: links to `docs/contributing.md` (today's README commands, moved there) and `CLAUDE.md`.
6. License: as above.

**Documentation pages (in `docs/`).**
- `getting-started.md`: supported browsers (Safari 26 on macOS, iOS and iPadOS; Chrome and Firefox desktop; Chrome
  Android), opening a decrypted disc folder (or its BDMV folder), installing the app, offline use.
- `playing-discs.md`: disc menus (HDMV and BD-J), audio and subtitle tracks, adding SRT and ASS files and episode
  subtitle sets, video shaders (Anime4K), keyboard, mouse, remote and touch controls, resume.
- `nas.md`: pairing with a NAS (code, QR, link), the title library, Continue watching, quality levels, the music shelf,
  subtitles stored on the NAS, playing from outside the home.
- `troubleshooting.md`: the notices players see (no picture for MPEG-2/VC-1 video outside quality levels, audio
  blocked by the browser, BD-J start-up, storage not lasting, a device no longer paired, a busy NAS) and what to do.
- `self-hosting.md`: unchanged, linked.
- `contributing.md`: the commands today's README lists, and a pointer to CLAUDE.md.
Every statement is checked against the code (the notice text in the UI, the actual keys in the key handler, the
browser support in CLAUDE.md).

**On the site.** A `/help` route renders the pages, with a small index and links between pages, reachable from a
"Help" link on the landing screen. The Markdown is converted to HTML at build time (a Vite plugin or a build-time
import), so the site and GitHub show the same files. Links between pages work in both places (relative `.md` links on
GitHub; the site maps them to `/help/<page>`). Links to repo-only pages (`contributing.md`, `CLAUDE.md`) go to GitHub
from the site. The help pages work offline like the rest of the app (the service worker serves the shell for `/help`
navigations) and add no third-party resources.

## 4. Constraints

- Cross-origin isolation stays intact: no external images, fonts or scripts on the help pages (shields.io badges live
  only in the README on GitHub, not on the site).
- The public-repo rule: made-up names in any example (Starfall Wanderer, Lantern Parade, `nas.example.com`).
- `src/engine/` keeps its own licence and must not import UI code; the help pages are UI.
- No user-agent sniffing.

## 5. Left to the builder

- The Markdown-to-HTML tool (a small, maintained dependency is fine) and how pages are bundled.
- The help pages' look, within the app's existing styles, dark and light.
- Exact wording of each page, within §3.
- Whether the landing screen's link reads "Help" or "Documentation".

## 6. Calls made without the owner (check these)

- C1. The site's section is `/help`, linked from the landing screen.
- C2. The page set in §3 (getting started, playing discs, NAS, troubleshooting, self-hosting, contributing).
- C3. Today's README commands move to `docs/contributing.md`; CLAUDE.md stays the developer reference.
- C4. Badges: six workflow statuses (CI, WASM, VM trace, BD-J trace, BD-J class library, ASS trace), licence, and a
  "Try it" link; no preview-deploy badge.
- C5. Pages are converted at build time, not in the browser.
- C6. `/help` and `/help/<page>` are real paths served by the app shell, the same way `/nas/…` deep links already are on
  Cloudflare Pages and offline through the service worker; the builder confirms a deep `/help/nas` link loads on a preview
  deploy.
- C7. Help is linked from the landing screen and from the NAS library's header, so it's reachable without closing a NAS
  screen; the player's menus don't get a link.
- C8. Tests: a unit test that every relative `.md` link between the pages resolves and that no page references an external
  image, and one browser test that `/help/nas` loads and its links work.
