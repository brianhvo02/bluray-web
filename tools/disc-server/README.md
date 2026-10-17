# disc-server: development disc server

Serves disc folders on this Mac to devices on the home network (iPhone, iPad, the iOS Simulator, other browsers), so a disc opens by URL instead of a folder pick. It also serves the built player from the same origin, so a device loads the app and the disc from one LAN URL in a secure, cross-origin-isolated context (SharedArrayBuffer needs both). Spec: `docs/superpowers/specs/2026-10-17-m5d-bdj-menus-design.md` §4.5. It is the seed of the NAS server (`docs/superpowers/specs/2026-10-16-cross-browser-and-remote-design.md` §4): same range-serving shape, same `HttpSource` in the engine.

Node built-ins only (run through `tsx`, already a devDependency).

## Run it

```sh
npm run build                    # the player the server hands out (dist/)
npm run disc-server -- --root fixtures/synthetic --root fixtures/local \
  --cert ~/.disc-server/cert.pem --key ~/.disc-server/key.pem
```

Options: `--root <dir>` (repeatable; every folder up to four levels below that contains `BDMV/index.bdmv` is a disc), `--port <n>` (default 8443), `--cert`/`--key` (PEM; without them the server speaks plain HTTP on 127.0.0.1 only, which is still a secure context for a browser on this Mac), `--dist <dir>` (default `dist`).

It prints:

- `Player (lists the discs): https://<lan-ip>:8443/?token=…`: the landing screen shows "On the disc server" with a button per disc.
- One `https://<lan-ip>:8443/?disc=…&token=…` URL per disc, which offers just that disc.

Tap the disc's button to open it (the tap is what lets audio start). The token is new on every run; links from an earlier run answer 401.

## Certificates (mkcert)

Devices only treat the page as a secure context over HTTPS with a certificate they trust. `mkcert` makes a local certificate authority and certificates signed by it:

```sh
brew install mkcert              # if it is not installed yet (Homebrew, user-level)
mkcert -install                  # creates the local CA and trusts it on this Mac (asks for your password)
mkdir -p ~/.disc-server
mkcert -cert-file ~/.disc-server/cert.pem -key-file ~/.disc-server/key.pem \
  "$(ipconfig getifaddr en0)" "$(hostname -s).local" localhost 127.0.0.1
```

The key stays outside the repository. Make a new certificate when the Mac's LAN address changes.

iPhone and iPad must install and trust the CA too: AirDrop `"$(mkcert -CAROOT)/rootCA.pem"` to the device, install the profile (Settings → General → VPN & Device Management), then enable full trust for it (Settings → General → About → Certificate Trust Settings). That one-time step is part of the device setup in `tools/devices/README.md`. The iOS Simulator takes it with `xcrun simctl keychain booted add-root-cert "$(mkcert -CAROOT)/rootCA.pem"`.

## What it serves

| Route | Token | Answer |
| --- | --- | --- |
| `GET /`, `GET /<file>` | no | The built player from `--dist`, with `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp` (as `public/_headers`) and `Cross-Origin-Resource-Policy: same-origin`. |
| `GET /discs` | yes | `[{ id, name }]`. `id` is a hash of the disc folder's real path, so it is stable across runs. |
| `GET /discs/<id>/manifest` | yes | `{ files: [{ path, size }] }`, paths relative to the disc folder (`BDMV/index.bdmv`). |
| `GET /discs/<id>/file/<path>` | yes | The file: `Range: bytes=a-b` gives 206 with `Content-Range`, a range starting past the end 416, no range 200. Streamed from disk, so files over 4 GiB cost no memory. `HEAD` too. |

The token goes in `Authorization: Bearer <token>` (what the player sends) or `?token=`. Disc responses carry `Cache-Control: no-store`, and the service worker never caches them.

## Who can connect

- The server listens only on loopback and on this Mac's private LAN addresses (10/8, 172.16/12, 192.168/16, 169.254/16), never on `0.0.0.0`, and refuses (403) any request whose source address is not loopback, private, link-local or IPv6 unique-local. Tailscale's 100.64/10 is not accepted: reaching discs from outside the home is the NAS server's job.
- Every disc request needs the per-run token (401 without it). The built player at `/` is public code and needs none.
- Paths with an empty, `.` or `..` segment, or with `/`, `\` or NUL once decoded, are refused (400). A file is only served if its real path (after links) is inside the disc folder.
- Read-only: only `GET`, `HEAD` and the CORS preflight `OPTIONS` are answered.

CORS: disc requests from another origin (the Vite dev server on this Mac, for example) get `Access-Control-Allow-Origin` for that origin, so `npm run dev` can open `?disc=https://<lan-ip>:8443/discs/<id>&token=…` too. The token still gates every read.

## Tests

`npx vitest run tools/disc-server src/engine/disc/http-source.test.ts` (plain HTTP on loopback; the 4 GiB case uses a sparse file).
