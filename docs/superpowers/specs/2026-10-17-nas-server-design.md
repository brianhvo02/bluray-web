# NAS Disc Server and the HTTPS Route (Step 2) — Design Spec

Date: 2026-10-17
Status: Draft
Parent spec: `2026-10-16-cross-browser-and-remote-design.md` §4 (step 2), with the pairing of §5.3. This document makes §4 concrete for the user's NAS; where it and the parent disagree, this one wins for step 2.

## 1. Intent

The user wants to watch the Blu-ray rips on their NAS from a phone, tablet or laptop, at home and abroad. On iPhone and iPad this is now the *only* practical way to watch full discs: Safari copies every picked file before a page can read it (about 7 MB/s measured, so an hour or more per disc). A server that answers byte-range reads copies nothing, so a disc opens as fast as its metadata arrives and plays as fast as the connection allows.

Success: on the iPad, the user opens the app, picks "Open from NAS", browses the folders as they sit on the drives, taps a disc, and gets its menus, chapters, audio and subtitle switching as with a local disc, starting within a few seconds at home and within a few more abroad over Tailscale.

## 2. The NAS as it is (recon, 2026-10-17)

- Host `mediaserver` on the user's tailnet (`mediaserver.tailnet-8e55.ts.net`, 100.124.127.85). Ubuntu 24.04.5, kernel 6.8, Intel N150, Docker 29.9 with Compose v5. User `administrator`, in the `docker` group, no passwordless sudo.
- Nine ext4 data drives at `/mnt/drv0`–`/mnt/drv8` (about 130 TB, mostly full). Disc rips live in a `BDMVs` folder on seven of them (`drv0, 2, 3, 5, 6, 7, 8`). Some of those folders hold a few hundred entries.
- About 1,200 discs (`BDMV/index.bdmv` within five levels of a `BDMVs` folder) and 15 `.iso` files. Layouts vary: a disc at the top level (`BDMVs/<disc>/BDMV`), discs grouped by series (`BDMVs/<series>/<volume>/BDMV`), CD+BD bundles with `BK` scan folders, and some `.mkv` remuxes and torrent files that aren't discs. UHD discs (HEVC, Dolby Vision, Atmos) are among them.
- Caddy (container `caddy`, network `caddy_default`) terminates HTTPS on the tailnet address, ports 80/443, with a Tailscale certificate from `/home/administrator/ts-cert`, and routes by path prefix (`/jellyfin`, `/vault`, `/photos`, …). Its Caddyfile is `/home/administrator/caddy/Caddyfile`.
- The N150's GPU is present (Alder Lake-N) but its kernel driver isn't loaded (no `/dev/dri`). That only matters for step 4.

## 3. Goals, non-goals, anti-goals

Goals:
- A read-only disc server on the NAS, deployed and updated by Claude over SSH (user's choice), behind the existing Caddy at `https://mediaserver.tailnet-8e55.ts.net/bluray/`.
- Folder browsing (user's choice): the seven `BDMVs` folders shown as one tree, as they sit on the drives, down to the discs.
- Open and play any disc in the library from every supported browser, with everything the local player does (menus, BD-J, subtitles, audio switching), including `.iso` discs.
- Paired devices only: nothing but "redeem an invite" answers an unpaired device (parent §2 anti-goal), even though the tailnet is private.

Non-goals (step 2):
- The WebRTC route and browser-only access for friends (step 3). Step 2 is reachable from the user's own Tailscale devices only.
- Transcoding (step 4), and loading the GPU driver.
- Titles, covers or metadata beyond folder names (a later nicety; the data model shouldn't preclude covers from `BK` scans or `bdmt_*.xml` titles).
- Writing anything to the drives. Ever.
- Managing Caddy beyond adding one route, or renewing its certificate.

Anti-goals:
- Disturbing the NAS's other services: no port changes, no Caddy restarts that drop other sites for more than a reload, no load that slows Jellyfin or qBittorrent noticeably (the library scan must be gentle on spinning disks).
- Serving the app from the NAS origin: it would share an origin with Vaultwarden and the other apps there.

## 4. Decisions

| Question | Decision | By |
|---|---|---|
| Who deploys | Claude, over SSH as `administrator` (in the `docker` group) | User |
| How the library looks | Folders as they sit on the drives; the seven `BDMVs` folders merged into one tree | User (folders); my call (merged) |
| Where it's served | Behind the existing Caddy, `handle_path /bluray/*`, on `caddy_default`; no new ports | My call (fits the NAS) |
| App origin | Stays `bluray-web.pages.dev`; the server answers cross-origin with CORS and CORP | My call (parent §4.5) |
| Auth on reads | Short-lived session token in the URL query, so range reads stay CORS-simple (no preflight per read) | My call |
| Stack | Node 24 + TypeScript in `server/`, sharing `src/engine/bdmv/` and the UDF reader | Parent §4.1 |
| ISO | Server-side in step 2 (UDF reader ported from libudfread, in `src/engine/disc/` so the client can use it later); local `.iso` opening deferred | Parent §4.7; deferral my call |
| Admin | A screen in the app, owner sessions only; the server serves JSON, no HTML | My call |
| Owner invites | Single-use, minted by `deploy.sh --owner-invite` per device; rerun to recover | My call |

## 5. The server

- **Package**: `server/` in this repo, built into a Docker image (`node:24-slim` base, pinned by digest). No native dependencies in step 2.
- **Deploy**: `server/deploy/compose.yaml` on the NAS under `/home/administrator/bluray-server/`: one service, `restart: unless-stopped`, on the external network `caddy_default`, each `/mnt/drvN/BDMVs` mounted read-only at `/library/drvN`, a named volume for state (`/data`: device keys, invites, scan cache). No published ports. A `server/deploy/deploy.sh` run from the Mac builds the image for `linux/amd64`, ships it with `docker save | ssh mediaserver docker load`, writes the compose file and restarts the service. No registry.
- **Caddy**: one block added inside the existing `https://mediaserver.tailnet-8e55.ts.net` site, `handle_path /bluray/* { reverse_proxy bluray-server:8080 }`, then `docker exec caddy caddy reload`. The deploy script makes this edit idempotently and keeps a backup of the Caddyfile.
- **Library scan**: walks the mounted roots breadth-first, stopping at discs (a folder containing `BDMV/index.bdmv`, or an `.iso` whose UDF tree has one) and skipping `BK`, `lost+found` and non-disc files. It reads only directory entries and `index.bdmv`/ISO headers, at low I/O priority, and caches the result in `/data`; a rescan runs on start, on demand from the admin page, and nightly. With 1,200 discs a cold scan may take minutes on HDDs; the UI shows the cached tree meanwhile.
- **Disc ID**: hash of the root-relative path (`drvN/…`) and `index.bdmv`'s size and mtime, so it survives rescans and changes when a disc is replaced.

## 6. API (all under `/bluray/api/`)

- `GET library?path=<folder>` → the folder's children: subfolders (name, how many discs below) and discs (id, name, total size, ISO or folder). Folder-by-folder, so the client never loads all 1,200 at once.
- `GET discs/<id>/manifest` → every file's path, size and mtime, plus the inlined contents of the metadata the engine reads at open (`index.bdmv`, `MovieObject.bdmv`, every `.mpls` and `.clpi`, `sound.bdmv`, `BDJO`, JAR sizes), so opening is one round trip (parent §4.2). For an ISO, each entry carries its extents in the image.
- `GET discs/<id>/files/<path>?t=<token>` with a single `Range` → bytes (206). For an ISO the server maps the path's extents. `Cache-Control: private, max-age=3600` on immutable disc bytes.
- `GET discs/<id>/probe?t=<token>` → 4 MB of the main clip for the throughput measurement (parent §4.4).
- Pairing and sessions: `POST pair/redeem` (invite secret + device public key), `POST session` (signed challenge → session token valid 1 hour, refreshed by the client before expiry).
- Admin (owner sessions only, JSON): `GET admin/devices`, `GET admin/invites`, `POST admin/invites`, `DELETE admin/devices/<id>`, `DELETE admin/invites/<id>`, `POST admin/rescan`. These change state and carry a JSON body or a non-GET method, so they go through a CORS preflight (`Access-Control-Max-Age: 600`); only reads must stay preflight-free.
- The manifest of an ISO disc lists its files as plain paths and sizes, like a folder disc; the server maps paths to extents itself, so the client needs no UDF reader in step 2.
- Every response: `Access-Control-Allow-Origin: https://bluray-web.pages.dev` (plus `http://localhost:5173` and `:4173` for development, and preview origins `https://*.bluray-web.pages.dev`), `Cross-Origin-Resource-Policy: cross-origin`, `Vary: Origin`. Range reads use only CORS-safelisted headers, so they need no preflight.

## 7. Pairing (step 2's part of parent §5.3)

- Owner invites: `deploy.sh --owner-invite` mints one single-use owner invite (a link) per run and prints it; the user runs it once per device, or creates more invites from an already paired owner device. Rerunning it is also the recovery if every owner device is lost or revoked (my call). Redeeming generates a non-extractable WebCrypto P-256 key pair on the device, stored in IndexedDB, and registers the public key.
- A session starts with a signed challenge and yields a session token (HMAC over device ID and expiry with a server secret in `/data`). Tokens ride in the query string of reads; revoking a device rejects its tokens at once.
- Admin is a screen inside the app (NAS settings: invites, devices with name and last seen, revoke, rescan), calling the admin endpoints with an owner session. The server serves no HTML, so nothing app-like runs on the NAS origin next to Vaultwarden (my call). No admin password in step 2.

## 8. The client

- **Landing**: "Open from NAS" next to "Open disc folder" once a NAS is paired. The NAS address and the device key live in IndexedDB.
- **Library**: a folder browser (breadcrumbs, folders first, discs with size and an "ISO" or "UHD" badge when known), touch-friendly, remembering the last folder.
- **Engine**: `RemoteSource` with an HTTPS `RangeTransport` in the worker, exactly as parent §4.3; the `open` command gains the `remote` variant. Remote read-ahead and start-up buffering as parent §4.4 (about 30 s ahead, several reads in flight, start after about 3 s buffered).
- **Pre-flight**: the measured throughput against the disc's peak rate, with a plain warning when it's lower (UHD discs at 60–100+ Mbps will often exceed a hotel connection; step 4 addresses that).
- **BD-J discs**: the BD-J worker reads the disc itself (`src/engine/bdj/bdj-worker.ts` builds its own `FileSource` from `discFiles`), so a remote BD-J disc hands the BD-J worker the manifest and a transport too, and it builds a `RemoteSource`; the JVM's disc reads are already async.
- **Chrome's Local Network Access**: requests from `bluray-web.pages.dev` to the tailnet name (a 100.64.0.0/10 address) may meet Chrome's local-network permission. The plan starts with a spike that checks it from Chrome, Edge, Safari and Firefox, for fetches from the page and from the worker. A one-time permission prompt is acceptable. If the permission can't cover reads made from a worker, the HTTPS transport runs on the main thread and serves the worker over a `MessagePort` (the same shape the WebRTC transport needs in step 3). No new ports or origins (my call).
- **Slow first reads**: the drives have no spin-down configured (no `hdparm`/`hd-idle` setup found), but a cold read on a busy HDD can still take seconds. The first read of a disc tolerates up to 30 s, and after 3 s the UI says "Waiting for the NAS drive…" instead of looking stuck.
- **Errors**: NAS unreachable, session expired (silently refreshed), device revoked (back to pairing), read failures with retry (parent §4.3).

## 9. Testing

- Server unit tests (Vitest): scan on a fixture tree (folder discs, series nesting, `BK`, `.mkv`, ISO), manifest contents against `fixtures/synthetic/`, range edge cases (start, end, past end, ISO extent boundaries), token and revocation rules, CORS headers.
- UDF reader tests against a small generated ISO of a synthetic disc (built by a script with `xorriso`/`genisoimage` in Docker, committed like the other fixtures).
- E2E: the server in a local container with `fixtures/synthetic/` as its library; the app paired to it; open and play `disc1`, `disc-menu`, `disc-bdj` and an ISO in Chromium, Firefox and WebKit.
- Device run (the remote-automation harness from step 1): iPad and iPhone open a real disc from the NAS over Tailscale, at home; seek; switch audio. Recorded in the status line.

## 10. Out of step 2

- Opening a local `.iso` file on the landing screen (parent §4.7): deferred, since the server handles ISO discs itself and iOS copies picked files anyway (my call).

## 11. Left to the builder

Library page layout details, scan scheduling details, exact token format, retry constants, how the deploy script detects the existing Caddy route, the fixture ISO's contents.
