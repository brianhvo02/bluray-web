# NAS Disc Server (Step 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only disc server on the user's NAS, behind its Caddy at `https://mediaserver.tailnet-8e55.ts.net/bluray/`, and the player support to pair with it, browse its folders and play any disc (folder or `.iso`, HDMV or BD-J) from every supported browser by byte-range reads.

**Architecture:** `server/` is a small Node 24 HTTP server (no framework) bundled with esbuild into one file and shipped as a Docker image to the NAS over SSH. It shares the BDMV parsers and a new UDF reader with the engine. In the engine, a serialisable `DiscSpec` (`files` or `remote`) replaces the picked-file list wherever a disc is opened (engine worker and BD-J worker), and a `RemoteSource` implements `ByteSource` over an HTTP range transport with sequential read-ahead. The UI gains pairing (WebCrypto keys), a folder browser, a pre-flight throughput check and an admin screen.

**Tech Stack:** TypeScript (strict), Node 24 (`node:http`), esbuild, Docker/Compose, Caddy, WebCrypto P-256, IndexedDB, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-17-nas-server-design.md` (parent: `docs/superpowers/specs/2026-10-16-cross-browser-and-remote-design.md` §4, §5.3).

## Global Constraints

- The server never writes to the library: each `/mnt/drvN/BDMVs` is mounted read-only at `/library/drvN`; state lives in the named volume at `/data`.
- Library roots on the NAS: `drv0, drv2, drv3, drv5, drv6, drv7, drv8` (each `/mnt/drvN/BDMVs`).
- No published ports. The container `bluray-server` listens on 8080 on the external network `caddy_default`; Caddy gets exactly `handle_path /bluray/* { reverse_proxy bluray-server:8080 }` inside the existing `https://mediaserver.tailnet-8e55.ts.net` block; the Caddyfile is backed up before each edit and Caddy is reloaded (`docker exec caddy caddy reload --config /etc/caddy/Caddyfile`), never restarted.
- The server serves JSON and disc bytes only, never HTML.
- CORS allow-list: `https://bluray-web.pages.dev`, any `https://<sub>.bluray-web.pages.dev`, `http://localhost:5173`, `http://localhost:4173`. Every response: `Access-Control-Allow-Origin: <origin>` (when allowed), `Vary: Origin`, `Cross-Origin-Resource-Policy: cross-origin`. Preflights: `Access-Control-Max-Age: 600`.
- Disc reads (`files`, `probe`) carry the session token as query `t=` and only CORS-safelisted headers (a single `Range: bytes=a-b`), so they need no preflight.
- Session token lifetime 1 hour; the client refreshes it 5 minutes before expiry.
- Disc bytes: `Cache-Control: private, max-age=3600`. Probe size 4 MiB (4,194,304 bytes).
- First read of a disc tolerates 30 s; after 3 s the UI shows `Waiting for the NAS drive…`.
- Remote read-ahead budget: 128 MiB (desktop profile), 48 MiB (constrained profile); playback starts once 3 s of stream are buffered.
- Unpaired devices get 401 on everything except `POST /api/pair/redeem` and `GET /api/health`.
- `src/engine/` stays LGPL and free of UI imports; `server/` imports engine code and is LGPL-2.1 too (`server/LICENSE`, `server/NOTICE` pointing at `src/engine/NOTICE`). Code ported from libudfread is recorded in `src/engine/NOTICE`.
- Copy: `Waiting for the NAS drive…`; `This disc changed on the NAS. Open its folder again.`; `Connection to the NAS lost.`; `This device is no longer paired with the NAS.`

## Review Focus

1. **Names with Japanese text, spaces, brackets, `#`, `?`, `%` or `+`** (`[BDMV] ReoNa - …`, `鋼の錬金術師 …`) must survive browse → open → read. Expected: every path round-trips; Task 3 and Task 5 test such names through the HTTP layer.
2. **A disc replaced or deleted after the folder was listed.** Expected: opening it answers 404 and the client shows `This disc changed on the NAS. Open its folder again.`; Task 5 tests the server side, Task 9 the message.
3. **A session token expiring during a feature-length film.** Expected: no interruption; reads that get 401 trigger one transparent refresh and retry; Task 7 tests it with a fake transport.
4. **Browsing while the first scan of ~1,200 discs is still running.** Expected: the cached tree (or the part scanned so far) is served at once, never a blocked request; Task 3 tests it.
5. **Ranges at the edges**: a range ending past EOF, the last partial chunk, a zero-length file, a range starting at EOF. Expected: 206 with the clamped length, or 416 with `Content-Range: bytes */<size>`; Task 5 tests each.

---

### Task 1: Server skeleton, image and deploy to the NAS

**Files:**
- Create: `server/src/main.ts`, `server/src/http.ts`, `server/src/cors.ts`, `server/src/cors.test.ts`, `server/src/config.ts`, `server/Dockerfile`, `server/deploy/compose.yaml`, `server/deploy/deploy.sh`, `server/deploy/caddy-route.sh`, `server/LICENSE`, `server/NOTICE`, `tsconfig.server.json`
- Modify: `tsconfig.json` (reference `tsconfig.server.json`), `vite.config.ts` (`test.include` gains `server/**/*.test.ts`), `package.json` (scripts `server:build`, `server:dev`, `server:deploy`)

**Interfaces:**
- Produces: `corsHeaders(origin: string | undefined): Record<string, string>`; `type Handler = (req: IncomingMessage, url: URL) => Promise<Response | null>` where `Response` is `{ status: number; headers?: Record<string,string>; body?: Buffer | string | Readable }`; `createServer(handlers: readonly Handler[]): http.Server` (applies CORS to every response, answers `OPTIONS` preflights, 404 when no handler matches). `loadConfig(env): { roots: { name: string; dir: string }[]; dataDir: string; port: number }` from `LIBRARY_ROOTS` (comma-separated `name=dir`), `DATA_DIR`, `PORT`.

- [ ] **Step 1: Write failing tests** in `server/src/cors.test.ts`: allowed origins (`https://bluray-web.pages.dev`, `https://fix-x.bluray-web.pages.dev`, `http://localhost:4173`) get `Access-Control-Allow-Origin` echoed; `https://evil.pages.dev`, `https://bluray-web.pages.dev.evil.com` and missing origin get none; every result has `Vary: Origin` and `Cross-Origin-Resource-Policy: cross-origin`. A test starting `createServer([])` on port 0: `GET /api/health` → 200 `{"ok":true}`; `OPTIONS /api/x` with an allowed origin → 204 with `Access-Control-Max-Age: 600` and allowed methods `GET, POST, DELETE`; unknown path → 404 JSON.
- [ ] **Step 2: Run** `npx vitest run server`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** the files above. `GET /api/health` is a built-in handler. `tsconfig.server.json`: strict like the app, `types: ["node"]`, `lib: ["ES2023"]`, includes `server/src` and the engine files it imports. `npm run server:build` bundles `server/src/main.ts` with esbuild (`--platform=node --format=esm --target=node24`) into `server/dist/server.mjs`. Dockerfile: `node:24-slim` pinned by digest (look up the current digest), copies `server/dist/server.mjs`, runs as the `node` user, `EXPOSE 8080`. `compose.yaml`: service `bluray-server`, `restart: unless-stopped`, network `caddy_default` (external), the seven read-only mounts and volume `bluray-data:/data`, env `LIBRARY_ROOTS=drv0=/library/drv0,…`, no `ports:`. `deploy.sh`: builds (`--platform linux/amd64`), `docker save | ssh mediaserver docker load`, copies `compose.yaml` to `~/bluray-server/`, `docker compose up -d`, then runs `caddy-route.sh` over SSH, which backs up the Caddyfile to `Caddyfile.bak-<timestamp>`, inserts the `/bluray/*` block before the site's closing brace only if absent, validates with `docker exec caddy caddy validate --config /etc/caddy/Caddyfile` (restoring the backup on failure), and reloads.
- [ ] **Step 4: Run** the tests and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Deploy** with `npm run server:deploy`, then from the Mac `curl -s https://mediaserver.tailnet-8e55.ts.net/bluray/api/health` → `{"ok":true}`, and `curl -s -o /dev/null -w '%{http_code}' https://mediaserver.tailnet-8e55.ts.net/jellyfin/` is unchanged from before the deploy (other sites unaffected).
- [ ] **Step 6: Commit** `feat(server): skeleton, image and deploy behind the NAS's Caddy`.

### Task 2: Local Network Access spike (go/no-go for where reads run)

**Files:**
- Create: `docs/superpowers/specs/2026-10-17-nas-lna-results.md` (findings), a throwaway probe page on the `device-test` preview branch (`public/lna.html` + `public/lna-worker.js`)

**Interfaces:**
- Produces: a ruling recorded in the findings file and the SDD ledger: `transport: 'worker' | 'main-thread'`, consumed by Task 7.

- [ ] **Step 1:** On the `device-test` branch (never merged), add `lna.html`: a button that fetches `https://mediaserver.tailnet-8e55.ts.net/bluray/api/health` from the page and from a module worker, also with `Range: bytes=0-15` against a known file once Task 5 exists (until then health only), and prints status, error, timing and whether a permission prompt appeared. Deploy it with `gh workflow run preview.yml --ref device-test`.
- [ ] **Step 2:** Run it in Chrome (installed, real profile via Playwright `channel: 'chrome'` with a persistent context, and by hand), Safari and Firefox on the Mac, and on the iPad and iPhone through the safaridriver harness (`scratchpad` scripts from step 1, re-created if gone). Record per browser: page fetch OK?, worker fetch OK?, prompt shown?, works after granting?
- [ ] **Step 3:** Decide: if every browser reaches the server from a worker (after at most one prompt granted on the page), `transport: 'worker'`; otherwise `'main-thread'`. Write the findings file with the table and the decision. If Chrome blocks with no way to grant, stop and raise it with the user (it decides whether the app must move origins, which the spec rules out).
- [ ] **Step 4: Commit** `docs(step 2): local network access results`.

### Task 3: Library scan and the browse API

**Files:**
- Create: `server/src/library.ts`, `server/src/library.test.ts`, `server/src/disc-id.ts`, `server/src/routes/library.ts`, `src/engine/disc/nas-api.ts` (the types shared by server and app; no runtime code)
- Modify: `server/src/main.ts` (register the route, start the scan)

**Interfaces:**
- Produces:
  ```ts
  // src/engine/disc/nas-api.ts
  interface DiscEntry { readonly id: string; readonly name: string; readonly path: string /* root-relative, e.g. 'drv5/[250226] きみの色' */; readonly kind: 'folder' | 'iso'; readonly sizeBytes: number }
  interface FolderEntry { readonly name: string; readonly path: string; readonly discs: number /* below it */ }
  // server/src/library.ts
  class Library {
    constructor(roots: readonly { name: string; dir: string }[], cacheFile: string);
    list(path: string): { folders: FolderEntry[]; discs: DiscEntry[] } | null; // null: unknown folder
    disc(id: string): DiscEntry | null;
    scan(): Promise<void>; // rescans; list() keeps answering from the previous tree meanwhile
    readonly scanning: boolean;
  }
  discId(rootRelativePath: string, indexSize: number, indexMtimeMs: number): string // 16 hex chars of sha256
  ```
  Route: `GET /api/library?path=<root-relative folder, '' for the top>` → `{ folders, discs, scanning }` (the top level lists the merged children of all roots, each child's `path` prefixed by its root name; sorted by name with `localeCompare(…, 'ja')`).

- [ ] **Step 1: Write failing tests**:
  - a temp tree with root `drvA` holding `Series (シリーズ)/Vol 1/BDMV/index.bdmv`, `Series (シリーズ)/Vol 1/BK/01.png`, `[BDMV] Single #1 100%/BDMV/index.bdmv`, `movie.mkv`, `x.torrent`, `lost+found/`, `disc.iso` (size only; ISO validation is Task 6), and root `drvB` holding `Other/BDMV/index.bdmv`.
  - `list('')` merges both roots: discs `[BDMV] Single #1 100%`, `disc.iso` (paths under `drvA/`) and `Other` (under `drvB/`), and the folder `Series (シリーズ)` with `discs: 1` (a folder that is itself a disc is listed as a disc); `movie.mkv`, `x.torrent`, `lost+found` and `BK` never appear.
  - `list('drvA/Series (シリーズ)')` → no folders, `discs: [Vol 1]`.
  - `discId` stable across two scans; changes when `index.bdmv` changes size.
  - `nextNightly(new Date('2026-10-17T03:59:00'))` → `2026-10-17T04:00:00`; at `04:00:00` → the next day's 04:00.
  - Review Focus 4: with a scan in progress (a root whose directory reads are slowed by an injected `readdir`), `list('')` returns the cached tree from the previous scan immediately and `scanning: true`.
  - Review Focus 1: through the HTTP route, `GET /api/library?path=` with `encodeURIComponent('drvA/Series (シリーズ)')` returns `Vol 1`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** The scan walks each root breadth-first with one directory read at a time (`fs.promises.opendir`), never descending into a disc, `BK`, `lost+found` or hidden entries, and caps depth at 6. The tree is written to `<dataDir>/library.json` after each scan and loaded at start. A scan runs at start, nightly at 04:00 server time (a `setTimeout` rescheduled after each run; test the next-run computation as a pure function `nextNightly(now: Date): Date`), and when `POST /api/admin/rescan` asks (Task 4 adds the route).
- [ ] **Step 4: Run** `npx vitest run server`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): library scan and folder browsing`.

### Task 4: Pairing, sessions and admin endpoints

**Files:**
- Create: `server/src/auth.ts`, `server/src/auth.test.ts`, `server/src/store.ts`, `server/src/routes/pair.ts`, `server/src/routes/admin.ts`, `server/src/cli.ts`
- Modify: `server/src/main.ts`, `server/deploy/deploy.sh` (`--owner-invite`: `ssh mediaserver docker exec bluray-server node server.mjs owner-invite` and print the link)

**Interfaces:**
- Produces:
  ```ts
  interface Device { readonly id: string; readonly name: string; readonly owner: boolean; readonly publicKeyJwk: JsonWebKey; readonly pairedAt: number; lastSeen: number }
  interface Invite { readonly id: string; readonly secretHash: string; readonly owner: boolean; readonly expiresAt: number; readonly forName: string }
  class Auth {
    constructor(store: Store, now: () => number);
    createInvite(opts: { owner: boolean; forName: string; ttlMs: number }): { invite: Invite; secret: string };
    redeem(secret: string, deviceName: string, publicKeyJwk: JsonWebKey): Device | null;   // single use
    challenge(deviceId: string): string | null;                                          // random, 60 s
    startSession(deviceId: string, challenge: string, signatureB64: string): { token: string; expiresAt: number } | null; // ECDSA P-256 SHA-256
    verify(token: string): Device | null;                                                // null: bad, expired or revoked
    revokeDevice(id: string): void; deleteInvite(id: string): void; devices(): Device[]; invites(): Invite[];
  }
  ```
  Routes: `POST /api/pair/redeem {secret, deviceName, publicKeyJwk}` → `{deviceId}`; `POST /api/session/challenge {deviceId}` → `{challenge}`; `POST /api/session {deviceId, challenge, signature}` → `{token, expiresAt}`; admin (owner token in `Authorization: Bearer`, preflighted): `GET /api/admin/devices`, `GET /api/admin/invites`, `POST /api/admin/invites {forName, owner}` → `{link}`, `DELETE /api/admin/devices/<id>`, `DELETE /api/admin/invites/<id>`, `POST /api/admin/rescan`. Every library and disc route requires a valid token (`t=` query or `Bearer`). Invite link format: `https://bluray-web.pages.dev/?nas=<url-encoded base>&invite=<secret>`. Owner invite TTL 24 h; other invites 72 h. Token: `base64url(deviceId.expiresAt).base64url(HMAC-SHA256)`, secret in `<dataDir>/secret` (created at first start, mode 600).

- [ ] **Step 1: Write failing tests**: redeem works once, second use → null; expired invite → null; challenge/sign/startSession with a key from `crypto.subtle.generateKey({name:'ECDSA', namedCurve:'P-256'})` → token; wrong signature → null; token verifies until `expiresAt` (1 h, via injected `now`), then null; `revokeDevice` makes its tokens fail at once; non-owner token on admin routes → 403; no token on `GET /api/library` → 401; `GET /api/health` and `POST /api/pair/redeem` work without a token; the store survives a restart (new `Auth` over the same files).
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** `Store` keeps devices and invites in `<dataDir>/auth.json`, written atomically (write temp, rename). `cli.ts owner-invite` prints the link.
- [ ] **Step 4: Run** `npx vitest run server`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): pairing, sessions and admin endpoints`.

### Task 5: Manifest, ranges and probe for folder discs

**Files:**
- Create: `server/src/manifest.ts`, `server/src/manifest.test.ts`, `server/src/ranges.ts`, `server/src/ranges.test.ts`, `server/src/routes/discs.ts`
- Modify: `server/src/main.ts`

**Interfaces:**
- Consumes: `Library.disc(id)` (Task 3), `Auth.verify` (Task 4).
- Produces (shared type added to `src/engine/disc/nas-api.ts`, imported by the server and by Tasks 7–9):
  ```ts
  interface DiscManifest {
    readonly discId: string;
    readonly name: string;
    readonly files: readonly { readonly path: string /* 'BDMV/STREAM/00001.M2TS', upper-case like normalizeDiscPaths */; readonly size: number }[];
    readonly inline: Readonly<Record<string, string>>; // path → base64 of the whole file
  }
  ```
  Inlined: `BDMV/INDEX.BDMV`, `BDMV/MOVIEOBJECT.BDMV`, `BDMV/PLAYLIST/*.MPLS`, `BDMV/CLIPINF/*.CLPI`, `BDMV/AUXDATA/SOUND.BDMV`, `BDMV/BDJO/*.BDJO`, `CERTIFICATE/ID.BDMV` (each only if present, each at most 1 MiB). Routes: `GET /api/discs/<id>/manifest`; `GET /api/discs/<id>/files/<encoded path>?t=` (Range or whole file); `GET /api/discs/<id>/probe?t=` (first 4 MiB of the largest `.M2TS`). `parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null` (null = no/invalid header → whole file).

- [ ] **Step 1: Write failing tests**:
  - `buildManifest` on `fixtures/synthetic/disc-menu` and `disc-bdj`: every file listed with its size; `inline` holds `BDMV/INDEX.BDMV` and the playlists/clip infos/BDJOs byte-identical to the files; no `.M2TS` or `.JAR` inlined.
  - `parseRange`: `bytes=0-99` on size 1000 → 0–99; `bytes=900-1999` → 900–999 (clamped); `bytes=1000-` → `'unsatisfiable'`; `bytes=-100` → 900–999; `bytes=0-0,5-9` → `null` (multi-range unsupported → whole file); size 0 with any range → `'unsatisfiable'`. (Review Focus 5.)
  - HTTP: `GET files/BDMV/STREAM/00001.M2TS` with `Range: bytes=192-383` → 206, `Content-Range: bytes 192-383/<size>`, body equal to the file's bytes 192–383, `Cache-Control: private, max-age=3600`, `Accept-Ranges: bytes`; past EOF → 416 with `Content-Range: bytes */<size>`; path traversal (`files/..%2F..%2Fetc%2Fpasswd`, `files/BDMV/../../x`) → 404; a disc ID the library doesn't know → 404 `{"error":"disc-changed"}` (Review Focus 2); a disc deleted after the scan (remove its folder in the temp tree, keep the cached library) → 404 `disc-changed`; a disc under a name with `#`, `%`, `+` and Japanese text plays its bytes (Review Focus 1); probe returns exactly 4,194,304 bytes (or the whole file if smaller).
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Paths are matched case-insensitively against the disc folder's real file names (discs on ext4 may be upper- or lower-case); resolved paths must stay inside the disc folder. Streams use `fs.createReadStream(file, { start, end })`.
- [ ] **Step 4: Run** `npx vitest run server`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): manifests, range reads and the probe`.

### Task 6: UDF reader and ISO discs on the server

**Files:**
- Create: `src/engine/disc/udf.ts`, `src/engine/disc/udf.test.ts`, `scripts/make-iso-fixture.sh` (Docker, `xorriso -as mkisofs -udf` from `fixtures/synthetic/disc1`), `fixtures/synthetic/disc1.iso` (generated, committed)
- Modify: `server/src/library.ts` (an `.iso` is a disc only if its UDF tree has `BDMV/INDEX.BDMV`), `server/src/manifest.ts`, `server/src/routes/discs.ts`, `src/engine/NOTICE`, `package.json` (`fixture:synthetic` also runs the ISO script)

**Interfaces:**
- Produces:
  ```ts
  interface UdfFile { readonly path: string /* upper-case, '/'-separated */; readonly size: number; readonly extents: readonly { readonly offset: number; readonly length: number }[] }
  readUdf(read: (offset: number, length: number) => Promise<Uint8Array>): Promise<UdfFile[]>
  ```
  The server's manifest for an ISO disc lists the same `path`/`size` shape as a folder disc; `files/<path>` reads map the range through `extents`.

- [ ] **Step 1: Generate** the fixture with `scripts/make-iso-fixture.sh` (record the xorriso version in the script). Confirm with `xorriso -indev fixtures/synthetic/disc1.iso -find / -type f` that it holds disc1's files.
- [ ] **Step 2: Write failing tests**: `readUdf` over `disc1.iso` lists every disc1 file with the same sizes; reading each file through its extents gives bytes identical to `fixtures/synthetic/disc1/…`; a non-UDF file (e.g. the first MiB of an `.M2TS`) → rejects with `not a UDF image`. Server: `disc1.iso` in a temp root becomes a disc of kind `iso`; its manifest equals disc1's folder manifest in paths, sizes and inlined bytes; a range read across an extent boundary returns the right bytes.
- [ ] **Step 3: Run** them. Expected: FAIL.
- [ ] **Step 4: Implement** `udf.ts`, ported from libudfread (`udfread.c`, `ecma167.c`) at the commit libbluray pins (`scripts/fetch-libbluray.sh` puts it under `.cache/libbluray/contrib/libudfread` or the submodule): anchor volume descriptor at sector 256, partition and logical volume descriptors, the metadata partition (UDF 2.50/2.60), file entries and extended file entries, short and long allocation descriptors, file identifier descriptors. Record the source files in `src/engine/NOTICE`.
- [ ] **Step 5: Run** `npx vitest run src/engine/disc/udf.test.ts server`. Expected: PASS.
- [ ] **Step 6: Commit** `feat: UDF reader and ISO discs on the NAS server`.

### Task 7: Remote discs in the engine

**Files:**
- Create: `src/engine/disc/disc-spec.ts`, `src/engine/disc/remote-source.ts`, `src/engine/disc/remote-source.test.ts`, `src/engine/disc/http-transport.ts`, `src/engine/disc/http-transport.test.ts`
- Modify: `src/engine/protocol.ts` (`open` carries a `DiscSpec`; new command `{ type: 'remoteToken'; token: string }`; notice code `nas-waiting`; event or error code for `disc-changed`, `nas-lost`, `nas-unpaired`), `src/engine/player.ts` (`open`, early BD-J boot, BD-J session boot), `src/engine/bdj/worker-protocol.ts` (`discFiles` → `disc: DiscSpec`), `src/engine/bdj/bdj-worker.ts`, `src/engine/bdj/session.ts`, `src/engine/memory-profile.ts` (`remoteReadAheadBytes`), `src/player/player-controller.ts` (`open(entries)` builds a `files` spec; new `openRemote(spec)`), every test that builds `discFiles`/`entries`

**Interfaces:**
- Consumes: `DiscManifest` (Task 5); the Task 2 ruling (`worker` or `main-thread` transport).
- Produces:
  ```ts
  type DiscSpec =
    | { readonly kind: 'files'; readonly entries: ReadonlyArray<readonly [string, Blob]> }
    | { readonly kind: 'remote'; readonly base: string /* …/bluray/api/discs/<id>/ */; readonly token: string; readonly manifest: DiscManifest; readonly port?: MessagePort /* main-thread transport only */ };
  createByteSource(spec: DiscSpec, deps: { fetch: typeof fetch; readAheadBytes: number; onWaiting(waiting: boolean): void }): ByteSource
  interface RangeTransport { read(path: string, offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>; setToken(token: string): void }
  class RemoteSource implements ByteSource { constructor(manifest: DiscManifest, transport: RangeTransport, opts: { readAheadBytes: number; chunkBytes: number /* 2 MiB */; inFlight: number /* 4 */ }) }
  ```
  `MEMORY_PROFILES.desktop.remoteReadAheadBytes = 128 * MiB`, `constrained = 48 * MiB`.

- [ ] **Step 1: Write failing tests** (fake transports, no network):
  - `RemoteSource.exists/size/list` answer from the manifest (case-insensitive like `FileSource`); `read` of an inlined file never calls the transport.
  - sequential reads of a 40 MiB fake clip in 2 MiB steps: after the first read, the transport has up to 4 chunks in flight ahead, and buffered bytes never exceed `readAheadBytes`; a read at a far offset (a seek) aborts the outstanding prefetches (their signals fire) and restarts the window there.
  - Review Focus 3: the transport answers 401 once; `HttpTransport` asks its `refreshToken()` callback once, retries with the new token, and the read succeeds; a second 401 after refresh rejects with `DiscError('read-failed', 'This device is no longer paired with the NAS.')`.
  - a first read that takes 3.5 s (fake timers) calls `onWaiting(true)` at 3 s and `onWaiting(false)` when it lands; a read still pending at 30 s rejects with `DiscError('read-failed', 'Connection to the NAS lost.')`.
  - a 404 `disc-changed` rejects with `DiscError('source-changed', 'This disc changed on the NAS. Open its folder again.')`.
  - `Player` opens a `remote` spec over a fake fetch serving `fixtures/synthetic/disc1` and `disc-bdj` (both the engine and the BD-J worker read through `RemoteSource`), reaches `playing`, and the `files` spec path is unchanged (existing tests pass untouched apart from the `discFiles` → `disc` rename).
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** `HttpTransport` builds `<base>files/<encodeURIComponent each segment>?t=<token>` with a single `Range: bytes=a-b` and no other headers. If Task 2 ruled `main-thread`, the spec carries a `MessagePort` and the worker's transport forwards reads over it to a `HttpTransport` on the main thread (same interface; transferred `ArrayBuffer`s). The controller relays token refreshes with `remoteToken`; the player passes them to its source and to the BD-J worker.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS (vm-trace and bdj-trace unchanged).
- [ ] **Step 5: Commit** `feat(engine): remote discs over HTTP range reads`.

### Task 8: NAS client, pairing and sessions in the app

**Files:**
- Create: `src/ui/nas/nas-store.ts` (IndexedDB: `{ base, deviceId, deviceName, owner, key: CryptoKeyPair }`), `src/ui/nas/nas-client.ts`, `src/ui/nas/nas-client.test.ts`, `src/ui/nas/PairScreen.tsx`
- Modify: `src/ui/db.ts` (new object store, version bump), `src/ui/App.tsx` (an `?nas=…&invite=…` URL opens the pair screen, then strips the query)

**Interfaces:**
- Produces:
  ```ts
  class NasClient {
    constructor(deps: { fetch: typeof fetch; subtle: SubtleCrypto; store: NasStore; now: () => number });
    static fromInvite(link: URL): { base: string; secret: string } | null;
    pair(base: string, secret: string, deviceName: string): Promise<void>;   // generates a non-extractable P-256 key pair
    session(): Promise<{ token: string; expiresAt: number }>;               // cached; refreshed 5 min before expiry
    library(path: string): Promise<{ folders: FolderEntry[]; discs: DiscEntry[]; scanning: boolean }>;
    manifest(discId: string): Promise<DiscManifest>;
    probe(discId: string): Promise<{ mbps: number }>;
    admin: { devices(); invites(); createInvite(forName: string, owner: boolean); revokeDevice(id: string); deleteInvite(id: string); rescan() };
  }
  ```
- [ ] **Step 1: Write failing tests** against a fake server (an in-memory `fetch` that implements Task 4's protocol with a real `Auth`): pair → session → library works; the private key is non-extractable (`extractable === false`); a session 56 minutes old is refreshed before use, a 50-minute-old one is reused; a 401 on `library` (revoked) clears the pairing and rejects with `This device is no longer paired with the NAS.`; `fromInvite` parses the Task 4 link format and rejects others.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Device name defaults to a short platform label (`iPad`, `iPhone`, `Mac Safari`, `Firefox`, …) editable on the pair screen. The pair screen shows the NAS host and a Pair button; errors in plain words.
- [ ] **Step 4: Run** `npx vitest run src/ui/nas` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): pair with the NAS`.

### Task 9: Folder browser, pre-flight and playing from the NAS

**Files:**
- Create: `src/ui/nas/LibraryScreen.tsx`, `src/ui/nas/library-model.ts`, `src/ui/nas/library-model.test.ts`, `src/ui/nas/Preflight.tsx`, `tests/e2e/nas.spec.ts`, `tests/e2e/nas-server.ts` (starts the built server on port 4190 with `fixtures/synthetic` as root `syn`)
- Modify: `src/ui/LandingScreen.tsx` ("Open from NAS" when paired), `src/player/player-controller.ts` (`openRemote`, token relay, mapping `nas-waiting` and the remote errors to notices/errors with the Global Constraints copy), `playwright.config.ts` (second `webServer` for the NAS server), `src/ui/styles.css`

**Interfaces:**
- Consumes: `NasClient` (Task 8), `PlayerController.openRemote(spec)` (Task 7).
- Produces: `libraryModel` pure helpers: breadcrumbs from a path, sort (folders first, then `localeCompare(…, 'ja')`), badges (`ISO`, and `UHD` when the manifest's main clip is HEVC 2160p — computed lazily, not in the listing), last-folder memory.

- [ ] **Step 1: Write failing tests**: `library-model` breadcrumbs for `drv5/[250226] きみの色` → `NAS › drv5 › [250226] きみの色`; sorting; E2E (`nas.spec.ts`, chromium, firefox, webkit — with `skipWithoutH264`): an owner invite minted by `node server/dist/server.mjs owner-invite` against the test server, opened as `/?nas=…&invite=…`, pairs; browse to `syn` → `disc1` → plays to `playing`; `disc-menu` shows its menu; `disc-bdj` plays the playlist Java selects; `disc1.iso` plays; a pre-flight line shows `This connection:` with a number; Review Focus 2: delete a disc folder from a temp copy of the root between listing and opening → the error `This disc changed on the NAS. Open its folder again.`
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Library screen: breadcrumbs, folder rows, disc rows with size and badges, 44 px rows on touch, "Rescanning…" when `scanning`. Pre-flight: probe once per open, show `This connection: N Mbps` and, when the main title's peak rate (CLPI `TS_recording_rate`, via the manifest's inlined clip info) exceeds it, `This disc needs about M Mbps; expect pauses.`; a Play button continues either way. Opening: `manifest` → `openRemote({ kind: 'remote', base, token, manifest })`.
- [ ] **Step 4: Run** the unit tests and `npx playwright test nas`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): browse and play discs from the NAS`.

### Task 10: Admin screen

**Files:**
- Create: `src/ui/nas/AdminScreen.tsx`, `src/ui/nas/admin-model.ts`, `src/ui/nas/admin-model.test.ts`
- Modify: `src/ui/nas/LibraryScreen.tsx` (an owner-only "NAS settings" entry), `tests/e2e/nas.spec.ts`

- [ ] **Step 1: Write failing tests**: admin-model formats device rows (`name · paired <date> · last seen <relative>`); E2E: the owner creates an invite for `Mum` (link shown with a Copy button), redeems it in a second browser context, the owner sees two devices, revokes `Mum`, and the second context's next library request shows `This device is no longer paired with the NAS.` and returns to the landing screen; Rescan shows `Rescanning…`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): NAS admin screen`.

### Task 11: Deploy, pair the user's devices, device run, docs

**Files:**
- Modify: `CLAUDE.md` (server commands, deploy, the `/bluray` route), `docs/known-issues.md`, `docs/superpowers/specs/2026-10-17-nas-server-design.md` (Status line), `README.md`

- [ ] **Step 1:** `npm run server:deploy`; check health, other Caddy sites unaffected, and the first scan's progress (`GET /api/library` shows `scanning` then the full top level with the seven roots' discs merged). Record how long the cold scan of ~1,200 discs took.
- [ ] **Step 2:** Mint one owner invite per device (`deploy.sh --owner-invite`) and give the links to the user for the iPad, iPhone and Mac; or, with the user's OK, redeem them through the remote-automation harness.
- [ ] **Step 3 (device run):** with the harness, on the iPad and iPhone over Tailscale: browse to a real folder disc and a real ISO, open, play 60 s, seek twice, switch audio; record start time (tap → first frame), throughput, stalls, A/V offset. Same on Mac Safari and Firefox. One UHD disc on the iPad to record what the connection does with it.
- [ ] **Step 4:** Docs: server commands and deploy in `CLAUDE.md`; known issues (Caddy's Tailscale certificate from Aug 31 is renewed by hand — when it lapses every app behind Caddy stops, this one included; UHD bitrates vs connections abroad until step 4; LNA results from Task 2); the spec's Status line with the device results.
- [ ] **Step 5: Commit** `docs: step 2 deployed and device results`.
