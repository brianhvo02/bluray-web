# Self-Hosting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An experienced self-hoster can run their own NAS server from the repo (published image, generic compose, a guide), pair with it on the public web app with or without their own rendezvous Worker, while the owner's Worker serves only the owner's NAS and the owner's values leave the repo.

**Architecture:** Pairing links gain `nas=` (redeem straight at a server) and `rv=` (look up and signal through another Worker); a pairing remembers its Worker. The Worker gains a `NAS_IDS` allowlist. The server loses the owner's defaults (`PUBLIC_BASE` required, `APP_URL`, `LOOKUP_CONTACT`) and builds links from its settings. Deployment becomes a generic compose file plus `.env`, a CI-published image, and an owner-only `deploy.sh --migrate`.

**Tech Stack:** TypeScript (Node server, React client, Cloudflare Worker), Vitest, Playwright, Docker Compose, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-22-self-hosting-design.md`

## Global Constraints

- The public repo rule: none of the owner's addresses, drive names, NAS id, ssh host or keys in any current file, test, example or guide; examples use made-up hosts such as `nas.example.com` and `rendezvous.example.workers.dev`. Git history is not rewritten.
- Existing pairings keep working: a stored pairing without a Worker of its own uses the app's built-in Worker (`VITE_RENDEZVOUS_URL`).
- `nas=` and `rv=` must be `https:` URLs; `http://localhost` / `http://127.0.0.1` only when `import.meta.env.DEV` (and in the E2E stand-in's origin list).
- The Worker allowlist secret is `NAS_IDS` (comma-separated NAS ids, the `TURN_NAS_IDS` pattern); unset or empty means open. A refused registration answers 403 `{ "error": "nas-not-allowed" }`.
- Server settings: `PUBLIC_BASE` (required; start-up fails with `PUBLIC_BASE is not set: the server's HTTPS API base as devices reach it, e.g. https://nas.example.com/bluray/api/`), `APP_URL` (default `https://bluray-web.pages.dev/`), `LOOKUP_CONTACT` (optional).
- The server writes only under `/data`; library mounts read-only; no native dependencies; tokens never logged.
- Image: `ghcr.io/brianhvo02/bluray-server`, linux/amd64, tags `latest` and the short commit, pushed only from main after CI's checks pass.

## Review Focus

1. A link with `nas=` pointing at a server that is down or not a bluray server: the pair screen shows a clear "couldn't reach that server" error, not a hang. → Task 3 test `a nas link to a server that doesn't answer fails with noRoute`.
2. A device paired through another Worker (`rv=`) later reconnecting over WebRTC: it must use that Worker, not the built-in one, even after a reload. → Task 3 test `signalling uses the pairing's own Worker`.
3. A pairing stored before this change (no `rendezvousUrl` field) after the update: unchanged behaviour. → Task 3 test `an old pairing uses the built-in Worker`.
4. The owner's Worker with `NAS_IDS` set and the owner's NAS already registered: nothing about the owner's NAS changes. → Task 1 test `an allowed NAS keeps lookup, signalling and TURN`.
5. `deploy.sh` run against a NAS whose `.env` lacks `PUBLIC_BASE` (migration not yet run): it stops before touching the running service. → Task 5 step 3 check.

---

### Task 1: Worker allowlist `NAS_IDS`

**Files:**
- Modify: `rendezvous/src/index.ts` (`Env.NAS_IDS?: string`; check in `route()`), `rendezvous/src/code-registry.ts` (`registerNas`), `rendezvous/src/turn.ts` (reuse the id-set parser), `rendezvous/wrangler.toml` (comment documenting `NAS_IDS`)
- Test: `rendezvous/src/worker.test.ts`, `rendezvous/src/turn.test.ts`

**Interfaces:**
- Produces: `nasIdAllowlist(raw: string | undefined): ReadonlySet<string> | null` in `rendezvous/src/turn.ts` (or a new `allowlist.ts`; `turnNasIds` then uses it): null means open. Refusals: `POST /nas` → 403 `nas-not-allowed`; `POST /codes/lookup` for a code whose NAS id is off the list → 404 as for an unknown code; `GET /signal/nas` and `/signal/device` with an off-list `nasId` → 403 `nas-not-allowed`; `/turn` already checks `TURN_NAS_IDS` and additionally checks `NAS_IDS` when set.

- [ ] **Step 1: Failing tests** in `worker.test.ts`: `with NAS_IDS unset any NAS registers`; `with NAS_IDS set a NAS off the list gets 403 nas-not-allowed`; `an allowed NAS keeps lookup, signalling and TURN`; `a NAS registered before NAS_IDS was set is refused at lookup (404) and signalling (403) once it is set`.
- [ ] **Step 2: Run** `npx vitest run rendezvous` → the new tests FAIL.
- [ ] **Step 3: Implement** the allowlist check in `route()` before the registry is touched (so a refused request costs no rate-limit count), and in lookup after the code resolves to its NAS id.
- [ ] **Step 4: Run** `npx vitest run rendezvous` and `npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(rendezvous): NAS_IDS allowlist`.

### Task 2: Server settings and links

**Files:**
- Modify: `server/src/config.ts` (drop `DEFAULT_PUBLIC_BASE`; `appUrl`, `lookupContact`), `server/src/codes.ts` (`pairingLink`), `server/src/cli.ts:39`, `server/src/routes/admin.ts:252`, `server/src/titles/musicbrainz.ts` and `discogs.ts` (User-Agent), `server/src/rendezvous-client.ts` or wherever the NAS registers (log a 403 `nas-not-allowed` once: `rendezvous refused this NAS (nas-not-allowed): add its id to the Worker's NAS_IDS`), `server/src/main.ts`
- Test: `server/src/config.test.ts`, `server/src/codes.test.ts`, `server/src/titles/musicbrainz.test.ts`, the registration client's test

**Interfaces:**
- Produces: `Config.appUrl: string` (always ends in `/`), `Config.lookupContact: string | null`; `pairingLink(code: string, o: { appUrl: string; publicBase: string; rendezvousUrl: string | undefined }): string` → `<appUrl>?pair=<code>` plus `&rv=<encoded rendezvousUrl>` when a Worker is set, else `&nas=<encoded publicBase>`; `lookupUserAgent(contact: string | null): string` → `bluray-web/1.0 (https://github.com/brianhvo02/bluray-web)` or `bluray-web/1.0 (https://github.com/brianhvo02/bluray-web; <contact>)`.

- [ ] **Step 1: Failing tests:** `loadConfig` throws the Global Constraints message without `PUBLIC_BASE`; `APP_URL` defaults to `https://bluray-web.pages.dev/` and gains a trailing slash; `pairingLink` with a Worker gives `https://bluray-web.pages.dev/?pair=ABCD2345EFGH&rv=https%3A%2F%2Frendezvous.example.workers.dev`, without one `…&nas=https%3A%2F%2Fnas.example.com%2Fbluray%2Fapi%2F`; the MusicBrainz request carries the contact when set; the registration client logs the `nas-not-allowed` line once for repeated 403s. Update every existing test that relied on the old default `PUBLIC_BASE` to set one (made-up host).
- [ ] **Step 2: Run** `npx vitest run server` → the new tests FAIL.
- [ ] **Step 3: Implement**, threading `appUrl`/`publicBase`/`rendezvousUrl` to both `pairingLink` callers and the contact to both lookup clients.
- [ ] **Step 4: Run** `npx vitest run server`, `npm run typecheck`, `npm run server:build` → PASS. Also confirm `tests/e2e/nas-server.ts` sets `PUBLIC_BASE` (add it if it relied on the default).
- [ ] **Step 5: Commit** `feat(server): required PUBLIC_BASE, APP_URL, LOOKUP_CONTACT and self-contained pairing links`.

### Task 3: App pairing through `nas=` and `rv=`

**Files:**
- Create: `src/ui/nas/pair-link.ts` (pure parsing and checks)
- Modify: `src/ui/App.tsx` (`takePairCode` → `takePairLink`), `src/ui/LandingScreen.tsx`, `src/ui/nas/PairScreen.tsx`, `src/ui/nas/nas-client.ts` (`lookup`, `pair`, `connect`, `canPairByCode`), `src/ui/nas/nas-store.ts` (`NasPairing.rendezvousUrl?`), `src/ui/nas/nas-messages` (wherever `NAS_MESSAGES` lives)
- Test: `src/ui/nas/pair-link.test.ts`, `src/ui/nas/nas-client.test.ts`, `tests/e2e/nas.spec.ts`

**Interfaces:**
- Produces:
  - `interface PairLink { readonly code: string; readonly nas?: string; readonly rv?: string }`; `parsePairLink(url: URL, o: { dev: boolean }): PairLink | null` (drops a `nas`/`rv` that isn't an allowed URL; returns null without `pair`); `foreignHosts(link: PairLink, builtIn: string | undefined): string[]` (the host names of `nas` and of an `rv` that isn't the built-in Worker, for the confirmation).
  - `NasPairing.rendezvousUrl?: string` (the Worker this pairing was made through; absent = built-in).
  - `NasClient.pair(code: string, deviceName: string, via?: { readonly nas?: string; readonly rv?: string }): Promise<void>`: with `nas`, no lookup (routes `{ https: nas }`); with `rv`, lookup and signalling through `rv`, stored on the pairing; `canPairByCode` stays tied to the built-in Worker, and a link with `nas` pairs even without one.
  - `NasClient.connect` uses `pairing.rendezvousUrl ?? deps.rendezvousUrl`.
  - Test ids: `pair-confirm` (lists the hosts, with `pair-confirm-continue` and Cancel), `pair-other-rendezvous` (the folded-away field's toggle) and `pair-rendezvous-url` (its input).

- [ ] **Step 1: Failing unit tests:** `parsePairLink` keeps `https` `nas`/`rv`, drops `http:` ones (kept only with `dev` for localhost), and null without `pair`; `foreignHosts` lists `nas.example.com` and `rendezvous.example.workers.dev` but not the built-in Worker; `pair with nas skips the lookup`; `pair with rv looks up at rv and stores it`; `signalling uses the pairing's own Worker`; `an old pairing uses the built-in Worker`; `a nas link to a server that doesn't answer fails with noRoute`.
- [ ] **Step 2: Run** `npx vitest run src/ui/nas` → FAIL.
- [ ] **Step 3: Implement.** The pair screen shows the confirmation (`pair-confirm`: "This link pairs with: <hosts>. Only continue if you trust them.") before redeeming whenever `foreignHosts` is non-empty; the "Use another rendezvous" field is folded away by default and, when filled, sends a typed code as `rv`.
- [ ] **Step 4: E2E.** In `tests/e2e/nas.spec.ts` add `a link carrying the server's address pairs without the Worker` (mint an owner code, open `/?pair=<code>&nas=<stand-in base>`, see `pair-confirm` naming the stand-in host, continue, reach the library) and `a link carrying another Worker pairs through it` (`rv=` the stand-in Worker's URL while the app's built-in one is unset or different). Build, then `npx playwright test tests/e2e/nas.spec.ts` (check ports 4191/4192 free first) → PASS on chromium, firefox, webkit.
- [ ] **Step 5: Run** `npm test`, `npm run typecheck` → PASS. **Commit** `feat(nas): pairing links that carry a server or a rendezvous Worker`.

### Task 4: Generic compose, settings example, published image

**Files:**
- Modify: `server/deploy/compose.yaml` (generic: every owner value from `.env`; one documented example root mount), `server/deploy/compose.gpu.yaml` (unchanged unless it names owner values), `server/Dockerfile` (copy `server/deploy/IMAGE-NOTICE` into the image), `.github/workflows/ci.yml` (job `publish-server-image`)
- Create: `server/deploy/.env.example`, `server/deploy/IMAGE-NOTICE` (GPL parts: jellyfin-ffmpeg 7 and Intel's media driver, their licences and source locations)
- Test: `docker compose -f server/deploy/compose.yaml --env-file server/deploy/.env.example config` renders; CI job runs only on main

**Interfaces:**
- Produces: `.env.example` keys exactly: `LIBRARY_ROOTS`, `LIBRARY_MOUNT` (the host folder bound read-only at `/library`), `PUBLIC_BASE`, `APP_URL`, `RENDEZVOUS_URL`, `RTC_LAN_ADDRESS`, `RTC_PORT`, `TRUSTED_PROXY`, `TZ`, `NIGHTLY_SCAN_AT`, `TITLE_LIBRARY`, `TMDB_API_KEY`, `DISCOGS_TOKEN`, `LOOKUP_CONTACT`, `LEVELS_BACKEND`, `BLURAY_IMAGE` (default `ghcr.io/brianhvo02/bluray-server:latest`), each with a one-line comment; the compose file's image is `${BLURAY_IMAGE:-ghcr.io/brianhvo02/bluray-server:latest}`.

- [ ] **Step 1:** Rewrite the compose file and write `.env.example`; keep `create_host_path: false` and read-only on the library mount, the data volume, the UDP port mapping `${RTC_PORT:-47998}`, and `env_file: .env`.
- [ ] **Step 2: Verify** `docker compose -f server/deploy/compose.yaml --env-file server/deploy/.env.example config >/dev/null` exits 0, and `git grep -n -e tailnet-8e55 -e 192.168.1.98 -e drv0 server/deploy` prints nothing.
- [ ] **Step 3:** CI job `publish-server-image` in `ci.yml`: `needs: [check, e2e, ass]`, `if: github.event_name == 'push' && github.ref == 'refs/heads/main'`, `permissions: { contents: read, packages: write }`, `npm ci`, `npm run server:build`, `docker/login-action` with `GITHUB_TOKEN`, `docker/build-push-action` for `linux/amd64` with tags `ghcr.io/brianhvo02/bluray-server:latest` and `:${{ github.sha }}` short (first 7 characters), context `server`, file `server/Dockerfile`. Validate the YAML parses.
- [ ] **Step 4: Commit** `feat(deploy): generic compose, .env.example and the published server image`.

### Task 5: The owner's deploy and migration

**Files:**
- Modify: `server/deploy/deploy.sh`, `server/deploy/caddy-route.sh`, `.gitignore` (`.env.local`)
- Create: `server/deploy/migrate-env.sh` (run by `deploy.sh --migrate`)

**Interfaces:**
- Produces: `deploy.sh` reads `BLURAY_NAS_HOST` (required, no default) and `BLURAY_CADDY_SITE` (required for the Caddy step) from the environment or a gitignored `.env.local` at the repo root; `deploy.sh --migrate` (one time) reads the NAS's current `~/bluray-server/compose.yaml`, writes the owner's values into the NAS's `~/bluray-server/.env` (keeping any lines already there, never printing secrets) and the drive mounts into `~/bluray-server/compose.override.yaml`, and changes nothing else; a normal deploy refuses with `the NAS's .env has no PUBLIC_BASE: run deploy.sh --migrate first` before shipping anything, and starts the service with `-f compose.yaml [-f compose.gpu.yaml] [-f compose.override.yaml]` (each only if present).

- [ ] **Step 1:** Implement, keeping today's build-and-ship path as the default and the Caddy reload-only rule.
- [ ] **Step 2: Verify** `bash -n server/deploy/*.sh`; `shellcheck server/deploy/*.sh` if installed; a dry run of `migrate-env.sh` against a copy of a compose file with made-up values (a temp dir, no ssh) produces the expected `.env` and override.
- [ ] **Step 3: Verify** the refusal: with `BLURAY_NAS_HOST` pointing at a fake ssh command (a stub script on `PATH` that answers an `.env` without `PUBLIC_BASE`), `deploy.sh` exits non-zero with the refusal message before any `docker` call.
- [ ] **Step 4: Commit** `feat(deploy): owner settings outside the repo and a one-time migration`.

### Task 6: The owner's values leave the current files

**Files:**
- Modify: every current file that names the owner's Tailscale host (`tailnet-8e55`), LAN address (`192.168.1.98`), drive layout (`drv0`…`drv8`, `BDMVs`, `Rips` as a root), Worker address (`bluray-rendezvous.brianhvo02.workers.dev`) or ssh host (`mediaserver` as a host name): including `src/ui/nas/nas-store.ts` (comment), `server/src/config.test.ts`, `tools/devices/live-check.ts`, `tools/bdj-library/sync.ts` (host from `--host` / `BDJ_LIBRARY_HOST`, no default), `CLAUDE.md`, `docs/known-issues.md`, and the specs and plans under `docs/superpowers/`.

- [ ] **Step 1:** Replace each with a setting or a made-up example (`nas.example.com`, `192.168.1.20`, `media1`, `rendezvous.example.workers.dev`, `your-nas`). Where a doc records history ("deployed on the owner's NAS"), keep the fact and drop the address.
- [ ] **Step 2: Verify** `git grep -n -i -e tailnet-8e55 -e 192.168.1.98 -e brianhvo02.workers.dev -e 'ssh mediaserver' -e '/mnt/drv'` prints nothing; `npm test`, `npm run typecheck` pass.
- [ ] **Step 3: Commit** `chore: the owner's addresses and drive layout leave the repo`.

### Task 7: The guide

**Files:**
- Create: `docs/self-hosting.md`
- Modify: `README.md` (a "Run your own server" link), `CLAUDE.md` (deploy commands, settings, the Worker allowlist, the image)

- [ ] **Step 1:** Write the guide per spec §3 "The guide": requirements; library layout (`LIBRARY_ROOTS`, read-only mount); `.env` from `.env.example`; `docker compose up -d`; the first owner code (`docker exec bluray-server node server.mjs owner-code`, link and QR); HTTPS (reverse proxy or Tailscale, `TRUSTED_PROXY`); optional Worker (`npx wrangler deploy` in `rendezvous/`, secrets `NAS_IDS` (their NAS id from `node server.mjs nas-id`), TURN secrets, `RENDEZVOUS_URL`, UDP `RTC_PORT` forward and `RTC_LAN_ADDRESS`); optional Quick Sync (`compose.gpu.yaml`); the data volume and backups; updating (`docker compose pull && docker compose up -d`); the GPL notice; the GPU-agnostic encoder as a future milestone. Made-up hosts only.
- [ ] **Step 2: Verify** every setting the guide names exists in `.env.example`, every command path exists, and the Task 6 grep still prints nothing.
- [ ] **Step 3: Commit** `docs: self-hosting guide`.

## After the plan (not tasks; owner actions, in order)

1. Set the Worker secret: `npx wrangler secret put NAS_IDS` with the owner's NAS id (from `deploy.sh --nas-id`), before the Worker with Task 1 deploys.
2. Run `deploy.sh --migrate` once, check the NAS's `.env`, then a normal deploy.
3. Make the `bluray-server` package public in GitHub's package settings after the first image is published.
