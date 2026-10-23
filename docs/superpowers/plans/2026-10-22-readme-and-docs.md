# README, Documentation, Licence and Bundled Anime4K Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Anime4K's shaders with the app, write player documentation shown both on GitHub and under `/help` on the site, add a top-level LGPL-2.1-or-later licence, and rewrite the README in React's style with status badges and a Built on section.

**Architecture:** Anime4K's 14 shader files are vendored under `src/ui/anime4k/shaders/` and exposed through a small `BundledShaders` source that the shader model treats like the player's own library (imported files win). The docs are Markdown in `docs/`, turned into HTML at build time and rendered by a `/help` route in the app. The README and `LICENSE` are plain files.

**Tech Stack:** React, Vite (asset URLs, `import.meta.glob`), vite-plugin-pwa (`injectManifest`), Vitest, Playwright, a small Markdown-to-HTML library at build time.

**Spec:** `docs/superpowers/specs/2026-10-22-readme-and-docs-design.md`

## Global Constraints

- Licence: LGPL-2.1-or-later for every part without its own licence; exceptions `src/bdj-classlib/` (GPLv2 with the Classpath Exception, plus the Apache, SAX and ICU notices its `NOTICE` lists) and `src/wasm/freetype/` (FreeType License); the server image also contains jellyfin-ffmpeg (GPL-3.0, `server/deploy/IMAGE-NOTICE`).
- Cross-origin isolation stays intact: the `/help` pages and the bundled shaders load nothing from other origins; README badges are on GitHub only.
- The public-repo rule: only made-up names in examples (Starfall Wanderer, Lantern Parade, `nas.example.com`).
- Every statement in the docs is true of the code at the time of writing (notice texts, keys, browsers, settings).
- TMDB's required notice, verbatim: "This product uses the TMDB API but is not endorsed or certified by TMDB."
- Badge order: CI, WASM, VM trace, BD-J trace, BD-J class library, ASS trace (GitHub `…/actions/workflows/<file>/badge.svg?branch=main`, linking to the workflow), then licence (`LGPL-2.1-or-later`, shields.io static, linking to `LICENSE`), then "Try it" linking to https://bluray-web.pages.dev.

## Review Focus

1. A player who imported their own `Anime4K_Restore_CNN_VL.glsl` before this change: their file is still the one used, not the bundled one. → Task 1 test `an imported file wins over the bundled one`.
2. A player offline after picking an Anime4K mode once: the mode still works offline. → Task 1 step 5 (service-worker runtime cache, checked in the build output).
3. A deep link `/help/troubleshooting` opened directly (not from the app): the page loads, and a link to another page works. → Task 3 browser test.
4. A docs page linking to `contributing.md` or `../CLAUDE.md`: on the site it goes to GitHub, not to a broken `/help/...`. → Task 3 unit test `repo-only links go to GitHub`.
5. A self-hosting guide link from the README or a help page: resolves on both GitHub and the site. → Task 3 unit test `every relative .md link resolves`.

---

### Task 1: Ship Anime4K

**Files:**
- Create: `src/ui/anime4k/shaders/*.glsl` (the 14 files the two `input-*.conf` files name), `src/ui/anime4k/shaders/README.md` (source repository, release tag and commit, file list), `src/ui/bundled-shaders.ts`
- Modify: `src/ui/shader-model.ts` (take a `BundledShaders`), the model's construction site, `vite.config.ts` and/or `src/sw.ts` (precache and runtime cache rules), `src/engine/NOTICE` or `src/ui/anime4k/README.md` (credit)
- Test: `src/ui/bundled-shaders.test.ts`, `src/ui/shader-model.test.ts`, `src/ui/shader-sets.test.ts`

**Interfaces:**
- Produces: `interface BundledShaders { readonly names: ReadonlySet<string>; load(name: string): Promise<string> }`; `bundledAnime4k(): BundledShaders` (real, from `import.meta.glob('./anime4k/shaders/*.glsl', { query: '?url', import: 'default' })` plus `fetch`); `ShaderModel` constructor gains `bundled: BundledShaders` (default `bundledAnime4k()` at the call site; tests pass a fake).

- [ ] **Step 1: Vendor the files.** Take them from one pinned Anime4K release (the newest tag on https://github.com/bloc97/Anime4K whose `glsl/` contains every file the confs name; record tag and commit). Byte-for-byte copies; keep `src/ui/anime4k/LICENSE` (MIT, © bloc97).
- [ ] **Step 2: Failing tests:** `bundled-shaders.test.ts`: `every file named in input-hq.conf and input-fast.conf is bundled` (parse the confs with `parseInputConf`, compare against the files on disk under `src/ui/anime4k/shaders/`). `shader-model.test.ts`: `built-in modes are available with nothing imported` (fake bundled names = all 14, empty library → all 12 built-ins available); `an imported file wins over the bundled one` (library has `Anime4K_Restore_CNN_VL.glsl` with text "MINE" → the applied set's source for that name is "MINE" and `load` is not called for it); `bundled files load only when a mode is applied` (no `load` call at `load()`/construction; calls only for the selected set's files); `a bundled file that fails to load leaves the mode unavailable with a report` (fake `load` rejects → `selectedMissing` true and nothing applied).
- [ ] **Step 3: Run** `npx vitest run src/ui/bundled-shaders.test.ts src/ui/shader-model.test.ts src/ui/shader-sets.test.ts` → FAIL.
- [ ] **Step 4: Implement.** Availability uses the library's names ∪ bundled names (`resolveSets` keeps its signature; the model passes the union). Sources come from the library first, then `bundled.load`.
- [ ] **Step 5: Offline and size.** The `.glsl` assets are not in the service worker's precache manifest; a runtime cache-first rule (same-origin, the built shader asset URLs) keeps them after first use. Verify: `npm run build`, then the precache manifest in `dist/sw.js` lists no `.glsl`, and `dist/assets` holds the 14 shaders.
- [ ] **Step 6: Run** `npm test`, `npm run typecheck`, and `SHADERS_GPU=1 npx playwright test shaders.spec --project=chromium` if WebGL2 float targets are available locally (else note it; CI's shader tests skip without a GPU). Add to the shader E2E a check that a built-in mode can be picked with nothing imported.
- [ ] **Step 7: Commit** `feat(shaders): ship Anime4K's shaders with the app`.

### Task 2: Player documentation pages

**Files:**
- Create: `docs/getting-started.md`, `docs/playing-discs.md`, `docs/nas.md`, `docs/troubleshooting.md`, `docs/contributing.md`
- Modify: none (README is Task 4)

- [ ] **Step 1: Write the pages per spec §3 "Documentation pages".** Plain Markdown, relative `.md` links between pages (`[NAS](nas.md)`), headings that read well as page titles (`# Getting started`). Shaders now work out of the box (Task 1). `contributing.md` holds today's README commands verbatim in a tidier order plus a pointer to `CLAUDE.md`.
- [ ] **Step 2: Verify every fact against the code**, recording each check in the task report: browser support (CLAUDE.md "Supported browsers"); every notice quoted from the UI source (`git grep` its text); every key from the key handler(s) under `src/ui/` (`git grep -n "key ===\|case '"`); every NAS setting or screen name from `src/ui/nas/`. No made-up feature. No real names.
- [ ] **Step 3: Commit** `docs: player documentation`.

### Task 3: `/help` on the site

**Files:**
- Create: `src/ui/help/HelpScreen.tsx`, `src/ui/help/help-pages.ts` (the page list and link mapping), a build-time Markdown loader (a Vite plugin in `vite/markdown.ts`, or `?raw` import plus a build-time transform), `src/ui/help/help-pages.test.ts`, `tests/e2e/help.spec.ts`
- Modify: `src/ui/App.tsx` (route `/help` and `/help/<page>`), `src/ui/LandingScreen.tsx` and the NAS library header (a "Help" link), `package.json` (one Markdown dependency), CSS for the help pages

**Interfaces:**
- Produces: `HELP_PAGES: readonly { slug: string; file: string; title: string }[]` with slugs `getting-started`, `playing-discs`, `nas`, `troubleshooting`, `self-hosting`; `helpHref(link: string, fromFile: string): string` (a relative link to another help page → `/help/<slug>[#hash]`; to any other repo file → `https://github.com/brianhvo02/bluray-web/blob/main/<path>`; absolute URLs unchanged); `/help` (no slug) shows the index.

- [ ] **Step 1: Failing unit tests** (`help-pages.test.ts`): `every relative .md link resolves` (for each page, every relative link resolves to an existing file in the repo); `help links map to /help` (`helpHref('nas.md#pairing', 'docs/getting-started.md')` → `/help/nas#pairing`); `repo-only links go to GitHub` (`helpHref('contributing.md', 'docs/nas.md')` and `helpHref('../CLAUDE.md', …)` → GitHub URLs); `no page references an external image` (no `![…](http…)` in any page).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Convert Markdown at build time (no Markdown parser in the shipped bundle); the screen renders the converted HTML with links rewritten by `helpHref`, a page list, and dark and light styles from the app's existing tokens. Routing: real paths `/help` and `/help/<slug>`, using the app's existing history handling; an unknown slug shows the index. Links: "Help" on the landing screen and in the NAS library header.
- [ ] **Step 4: Run** the unit tests → PASS; `npm run typecheck`; `npm test`.
- [ ] **Step 5: Browser test** `tests/e2e/help.spec.ts`: open `/help/troubleshooting` directly → its title shows; follow a link to another help page → that page shows at `/help/<slug>`; the landing screen's Help link opens `/help`. Run on chromium, firefox and webkit.
- [ ] **Step 6: Deep links in production.** Confirm the static host serves the app shell for `/help/<slug>` as it does for `/nas/…` (check how the site handles `/nas/…` deep links today: `public/` redirects or the host's SPA fallback); if a rule is needed, add it. After merge, check `/help/nas` on the live site (or a preview deploy: `gh workflow run preview.yml --ref <branch>`).
- [ ] **Step 7: Commit** `feat(help): documentation pages on the site`.

### Task 4: Licence and README

**Files:**
- Create: `LICENSE` (the full LGPL-2.1 text, identical to `src/engine/LICENSE`)
- Modify: `README.md` (rewrite), `package.json` (`"license": "LGPL-2.1-or-later"`), `CLAUDE.md` (one line on the docs and `/help`)

- [ ] **Step 1: Write `LICENSE` and the `package.json` field.**
- [ ] **Step 2: Rewrite `README.md`** per spec §3 "README sections": badges (Global Constraints order), introduction, Get started, Documentation (links to the `docs/` pages and `/help`), Run your own server, Contributing, Built on, License.
- [ ] **Step 3: Built on.** Build the list from the repo's records: `src/engine/NOTICE`, `src/bdj-classlib/NOTICE`, `src/wasm/freetype/NOTICE`, `server/NOTICE`, `server/deploy/IMAGE-NOTICE`, the runtime `dependencies` of `package.json`, `server/package.json` (if any) and `rendezvous/`, the licence files under `fixtures/`, `src/ui/anime4k/LICENSE`, `src/engine/ass/LICENSE-DejaVu.txt`, and `tools/*/Dockerfile` base images. Groups and contents per spec §3 item 6 (Ported from, Bundled, Used in tests, Services and data, Tools); each entry links to the project's home or repository and names its licence where one applies; TMDB's notice verbatim. Record in the task report, for each entry, the file that justified it.
- [ ] **Step 4: Verify** every badge URL names an existing workflow file (`ls .github/workflows`), every README link to a repo file exists, and no real names appear.
- [ ] **Step 5: Commit** `docs: README, licence and Built on`.
