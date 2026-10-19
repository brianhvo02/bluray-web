# The WebRTC Route Implementation Plan (Step 3, Release 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A friend's browser anywhere reaches the NAS peer-to-peer over a WebRTC data channel. It can pair over that channel, open and play any disc, optionally fall back to a Cloudflare relay, and buffer first when the connection is slower than the disc.

**Architecture:**
- **Everything that talks to the NAS is already fetch-shaped.** `NasClient` and `HttpTransport` take an injected `fetch`. So the WebRTC route is a `fetch` implementation over one ordered data channel, and the NAS dispatches those requests into its existing HTTP handler chain unchanged.
- **Where the connection lives:** `RTCPeerConnection` exists only on the main thread. The engine and BD-J workers reach it through a fetch-over-`MessagePort` bridge.
- **Signalling:** a new Durable Object on the rendezvous Worker relays offers, answers and ICE candidates over WebSockets. The NAS keeps one outbound socket open.
- **NAS side:** werift (pure JS), on fixed UDP port 47998.

**Tech Stack:**
- Node 24 + TypeScript (`server/`, esbuild bundle);
- werift (MIT) on the NAS;
- browser `RTCPeerConnection`;
- Cloudflare Worker + Durable Objects (hibernatable WebSockets);
- the Origin Private File System for the buffer;
- Vitest and Playwright.

**Spec:** `docs/superpowers/specs/2026-10-18-webrtc-people-design.md` §6 and §7, with the spike results under §6.1. Release 1 (§4–§5) is deployed. Spike code for reference (candidate rewriting, the werift port setup, the page's measurement loop): `/private/tmp/claude-501/-Users-takeakisoba-bluray-web/53b1d395-739f-4023-bbc1-f392ef462fa1/scratchpad/spike/server.mjs` and `index.html`. That folder is throwaway, so read it only and don't copy files out of it wholesale.

## Global Constraints

- **Anti-goal:** nothing answers an unpaired device except `POST /api/pair/redeem`, `POST /api/session/challenge`, `POST /api/session` and `GET /api/health`, on any route. Over WebRTC, a connection that hasn't completed `POST /api/session` within 30 s, or that fails one session attempt, is closed.
- **Data channel layout:** one channel labelled `api`, ordered and reliable. Body chunks are at most 64 KB (65536 bytes) per message. Flow control uses `bufferedAmount` with `bufferedAmountLowThreshold` = 1 MB and a high-water mark of 4 MB.
- **NAS UDP:** ICE uses only UDP port 47998, published by compose as `47998:47998/udp`. The NAS advertises only host candidates for its current public IPv4 (found by STUN at start and then hourly) and for `RTC_LAN_ADDRESS` (192.168.1.98 in the deployed compose), each on port 47998. It never advertises Docker (172.16.0.0/12) or Tailscale (100.64.0.0/10) addresses.
- **STUN:** `stun:stun.cloudflare.com:3478`.
- **Route choice:** HTTPS first with a 2 s timeout (`GET <https base>health`), then WebRTC. The choice is remembered per NAS for the page's life and retried when it breaks.
- **Relay:**
  - It is off by default. Only the owner turns it on.
  - The free allowance is 1,000 GB a month (1e12 bytes). At the allowance, new relayed sessions are refused unless "allow paid use" is on. Usage resets on the 1st of the month, UTC.
  - TURN credentials last 1 hour, and the Worker mints them only on the NAS's signed request.
  - The Cloudflare TURN key id and API token are Worker secrets only (`TURN_KEY_ID`, `TURN_KEY_API_TOKEN`), never in the repo.
- **Copy (exact):**
  - "Relayed"
  - "Relay this month: {used} of 1,000 GB free"
  - "The relay's free allowance for this month is used up. It resets on {date}."
  - "Can't connect to the NAS from this network. Try another Wi-Fi or mobile data."
  - "About {n} minutes before it can play straight through"
  - "Lower quality (coming later)"
- **Buffer-first:**
  - Rate = the main playlist's bytes ÷ duration × 1.1.
  - Wait = duration × (1 − connection ÷ rate).
  - Silent below 120 s; above that, the pre-flight offers Wait, Play now with pauses and Lower quality (disabled).
  - The cache lives in OPFS, per disc. It is cleared when another disc opens or after 24 h.
- **Signalling limits:** 10 connection attempts per minute per IP and 100 per minute per NAS. The Worker forwards only `offer`, `answer`, `candidate`, `turn-request` and `turn-response` messages, of at most 16 KB each.
- **Stack constraints:**
  - `src/engine/` imports nothing from `src/ui/` or `src/player/`.
  - The server has no native dependencies (werift is pure JS).
  - The repo is public: made-up names only.
  - Never write under `/mnt`. Caddy is reloaded only. The TMDB key stays in the NAS `.env`.

## Review Focus

1. **A seek during a long range read over WebRTC.** The cancelled request must stop its chunks on both ends at once, the channel must stay usable, and no chunk from the cancelled read may be delivered to the next request with the same path. (Task 1 wire tests, Task 2 dispatch tests.)
2. **The data channel closing mid-playback** (Wi-Fi to cellular, NAS restart). In-flight reads reject as `nas-lost`, and the client reconnects once on the next request rather than staying dead. (Task 6.)
3. **An unpaired peer** sending a library, disc or bdj-store request, or sending garbage frames or an oversized head. It gets 401 or 400, and garbage closes the connection; the server never crashes. (Task 2.)
4. **A NAS whose public IPv4 changes while it runs.** The next STUN refresh updates the advertised candidate without a restart. (Task 4.)
5. **Buffer-first on iOS, where OPFS quota is small or `persist()` is refused.** The pre-flight says how much it can hold and offers pauses instead of a wait that can't finish. (Task 9.)

---

### Task 1: The wire protocol and fetch over a MessagePort

**Files:**
- Create: `src/engine/disc/rtc-wire.ts`, `src/engine/disc/port-fetch.ts`
- Test: `src/engine/disc/rtc-wire.test.ts`, `src/engine/disc/port-fetch.test.ts`

**Interfaces:**
- Produces, in `rtc-wire.ts` (pure; used by the server and the browser):
  - `interface WireChannel { send(data: string | Uint8Array): void; readonly bufferedAmount: number; bufferedAmountLowThreshold: number; onbufferedamountlow: (() => void) | null; onmessage: ((data: string | Uint8Array) => void) | null; onclose: (() => void) | null; close(): void }`, a structural subset that both werift and browser channels adapt to.
  - Text frames are JSON:
    - `{t:'req', id, method, path, headers}`
    - `{t:'body-end', id}`
    - `{t:'res', id, status, headers}`
    - `{t:'end', id}`
    - `{t:'cancel', id}`
    - `{t:'error', id, message}`
  - Binary frames are body chunks: a 4-byte big-endian request id, then up to 65536 bytes of payload.
  - `MAX_CHUNK = 65536`, `LOW_WATER = 1 << 20`, `HIGH_WATER = 4 << 20`, `MAX_HEAD_BYTES = 16384`
  - `class WireClient { constructor(channel: WireChannel); fetch(url: string, init?: RequestInit): Promise<Response>; close(reason: Error): void }`
    - `fetch` takes only the URL's path and query. The response body is a `ReadableStream` that rejects if the channel closes.
    - `init.signal` abort sends `cancel`.
  - `class WireServer { constructor(channel: WireChannel, handle: (req: WireRequest) => Promise<WireResponse>); close(): void }`
    - `WireRequest = { method; path; headers: Record<string,string>; body: AsyncIterable<Uint8Array>; signal: AbortSignal }`
    - `WireResponse = { status; headers; body: AsyncIterable<Uint8Array> | Uint8Array | string | null }`
    - It paces sends by the water marks.
- Produces, in `port-fetch.ts`:
  - `serveFetch(port: MessagePort, fetchFn: typeof fetch): () => void`, which returns a stop function;
  - `portFetch(port: MessagePort): typeof fetch`.
  - Bodies stream as transferred `ArrayBuffer` chunks, and abort crosses the port.

- [ ] **Step 1: Write the failing tests.** Use an in-memory `WireChannel` pair with a settable `bufferedAmount`.
  - `rtc-wire.test.ts`:
    - A GET with a 200 KB response arrives byte-exact, as 4 chunks of 64 KB or less.
    - A PUT with a 100 KB body reaches the handler intact.
    - **Interleaving:** two concurrent requests' chunks interleave and each body is correct.
    - **Aborts** (Review Focus 1): aborting mid-body sends `cancel`, the handler's `signal` aborts, no further chunks for that id are delivered, and a new request on the same channel succeeds.
    - **Closing** (Review Focus 2): closing the channel rejects pending fetches and errors open bodies.
    - **Garbage** (Review Focus 3): a head over 16 KB, invalid JSON, or a binary frame for an unknown id each close the channel. `WireServer` never throws out of `onmessage`.
    - **Backpressure:** the server stops sending while `bufferedAmount > HIGH_WATER` and resumes on `onbufferedamountlow`.
  - `port-fetch.test.ts`: using a real `MessageChannel` from `node:worker_threads`, a streamed body, abort and an error all cross the port.
- [ ] **Step 2: Run** `npx vitest run src/engine/disc/rtc-wire.test.ts src/engine/disc/port-fetch.test.ts`. Expect failures.
- [ ] **Step 3: Implement** both modules. Responses are real `Response` objects, built with `new Response(stream, {status, headers})`.
- [ ] **Step 4: Run** the same tests and `npm run typecheck`. Everything passes.
- [ ] **Step 5: Commit** `feat(disc): a fetch over a WebRTC data channel and over a MessagePort`.

### Task 2: The NAS answers requests from a data channel

**Files:**
- Modify: `server/src/http.ts` (export `handle(handlers, req): Promise<Response>`, the existing `route` with health included, and `responseHeaders(origin, response)`), `server/src/auth.ts`, `server/src/app.ts`
- Create: `server/src/rtc/dispatch.ts`
- Test: `server/src/rtc/dispatch.test.ts`

**Interfaces:**
- Consumes `WireServer`, `WireChannel` and `WireRequest` from Task 1.
- Produces:
  - `serveChannel(channel: WireChannel, handlers: readonly Handler[], opts: { auth: Auth; remoteAddress: string; now: () => number; onSession?: (deviceId: string) => void }): { close(): void }`.
    - It turns each `WireRequest` into a minimal `IncomingMessage` stand-in: a `Readable` from `body`, with `method`, `url`, `headers` (lowercased) and `socket.remoteAddress`. That is what `readJson`, `clientAddress` and the routes use.
    - It sends `Response` bodies, Buffer or string or `Readable`, through the wire.
  - **Gate:** before a `POST /api/session` on this channel answers 200, only the four open routes are dispatched; everything else is answered 401 without running a handler. After the 200, the session's device id is recorded and `onSession(deviceId)` fires. The gate closes the channel after 30 s without a session, or after a session attempt answers 401.
  - `Auth.onDeviceGone(listener: (deviceId: string) => void): () => void` fires on `revokeDevice` and on `removePerson` (once per device), not on `moveDevice`. `serveChannel` closes a channel whose device is gone.
  - `Device.lastRoute?: 'https' | 'webrtc' | 'relay'`, set by a new `Auth.noteRoute(deviceId, route)`, which `startSession` callers use. The HTTPS session route notes `https`. The rtc layer notes `webrtc` or `relay` (Task 4) through `onSession`. `GET admin/people` devices include `lastRoute` (closes ruling R4 of release 1).

- [ ] **Step 1: Write the failing tests** in `dispatch.test.ts`, with `appHandlers` on a temp data dir as in `routes/admin.test.ts`:
  - **Unpaired:** an unpaired channel gets 401 on `GET /api/library?path=` (Review Focus 3), and the handler never runs.
  - **Redeem:** `POST /api/pair/redeem` with a valid code pairs.
  - **Session:** challenge, then `POST /api/session` gives 200. After that, `GET /api/library` with `Authorization: Bearer <token>` is 200.
  - **Range read:** `GET /api/discs/<id>/files/BDMV/index.bdmv?t=` with `Range` gives a 206 whose bytes are exact.
  - **Failed session:** after one failed session attempt the channel is closed.
  - **Timeout:** with a fake clock, a channel with no session is closed at 30 s.
  - **Revoked device:** revoking the device closes its channel.
  - **Garbage:** frames close the channel, and the server stays up.
  - **Last route:** `lastRoute` is `https` after an HTTPS session and `webrtc` after `onSession` notes it.
- [ ] **Step 2: Run** `npx vitest run server/src/rtc server/src/auth.test.ts`. Expect failures.
- [ ] **Step 3: Implement.** Keep `createServer` using the same exported `handle` and header helper, so both routes answer identically, CORS and safety headers included.
- [ ] **Step 4: Run** `npx vitest run server/src` and `npm run typecheck`. Everything passes.
- [ ] **Step 5: Commit** `feat(server): answer API requests from a data channel, gated until a session`.

### Task 3: Signalling on the rendezvous Worker

**Files:**
- Create: `rendezvous/src/signalling.ts` (Durable Object `Signalling`, one per NAS via `idFromName(nasId)`)
- Modify: `rendezvous/src/index.ts`, `rendezvous/src/code-registry.ts` (an internal `GET /internal/nas-key?nasId=` that `index.ts` never routes from outside), `rendezvous/src/protocol.ts`, `rendezvous/wrangler.toml` (binding `SIGNALLING`, migration tag `v2` with `new_sqlite_classes = ["Signalling"]`), `src/engine/disc/nas-api.ts` (`CodeRoutes` gains `webrtc?: { nasId: string }`)
- Test: `rendezvous/src/signalling.test.ts`, `rendezvous/src/worker.test.ts`

**Interfaces:**
- **Routes (WebSocket upgrades):**
  - `GET /signal/nas?nasId=` is the NAS socket. The DO sends `{t:'challenge', nonce}`, and the NAS answers `{t:'auth', signature}` over `signalAuthMessage({nasId, nonce})` (type tag `signal-nas`), verified against the key from CodeRegistry. One NAS socket per NAS; a new one replaces the old.
  - `GET /signal/device?nasId=` is the device socket. If no NAS socket is live, the DO closes it with code 4404 and reason `nas-offline`. The DO gives each device socket a `sid` (random 16 bytes, base64url).
- **Forwarding:** device to NAS, `{t:'offer'|'candidate'|'turn-request', ...}` goes out as `{...msg, sid}`. NAS to device, `{t:'answer'|'candidate'|'turn-response', sid, ...}` goes to that sid without the `sid` field. Any other `t`, or a message over 16 KB, closes the sender (device) or is dropped (NAS).
- **Limits:** as in Global Constraints. The per-IP limit uses `CF-Connecting-IP`.
- **Lookup:** `POST /codes/lookup` answers `routes: { https?, webrtc: { nasId } }`. The Worker adds `webrtc` for every code, since every registered NAS can signal.
- **Hibernation:** use the hibernatable WebSocket API (`state.acceptWebSocket`, `webSocketMessage`), keeping per-socket state in `serializeAttachment`.

- [ ] **Step 1: Write the failing tests.** Follow the existing `worker.test.ts` pattern and use a fake `DurableObjectState` with fake sockets.
  - NAS auth: a good signature passes. A bad signature, or a register-message signature replayed, closes the socket.
  - A device socket while the NAS is offline gets 4404.
  - `offer` is forwarded with `sid`, and `answer` comes back to the right device without `sid`.
  - An unknown `t` closes the device.
  - A message of 16 KB + 1 is rejected.
  - The per-IP and per-NAS limits.
  - The lookup includes `webrtc.nasId`.
- [ ] **Step 2: Run** `npx vitest run rendezvous/src`. Expect failures.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run rendezvous/src` and `npm run typecheck`. Everything passes.
- [ ] **Step 5: Commit** `feat(rendezvous): WebRTC signalling between devices and their NAS`.

### Task 4: The NAS's peer: werift, signalling client, candidates

**Files:**
- Create: `server/src/rtc/peer.ts`, `server/src/rtc/signalling-client.ts`, `server/src/rtc/public-address.ts`
- Modify: `server/src/main.ts`, `server/src/config.ts` (`RTC_PORT` default 47998, `RTC_LAN_ADDRESS`, `RTC_ADVERTISE` for tests, which replaces discovery with a fixed list), `server/src/rendezvous-client.ts` (exposes its key for signing `signal-nas`), `server/deploy/compose.yaml` (`ports: ["47998:47998/udp"]`, `RTC_LAN_ADDRESS: 192.168.1.98`), `server/NOTICE` (werift, MIT), `package.json` (werift, pinned exact)
- Test: `server/src/rtc/peer.test.ts`, `server/src/rtc/public-address.test.ts`, `server/src/rtc/signalling-client.test.ts`

**Interfaces:**
- Consumes Task 2's `serveChannel` and Task 3's message shapes.
- Produces:
  - `class RtcPeers { constructor(opts: { handlers; auth; port: number; advertise: () => string[]; iceServers: () => Promise<RTCIceServerLike[]>; now }); answer(sid: string, offer: string): Promise<{ answer: string }>; candidate(sid: string, c: unknown): void; closeAll(): void }`.
    - One werift `RTCPeerConnection` per sid.
    - `icePortRange` is `[port, port + 1]` narrowed to `port`, as the spike does: werift refuses equal ends.
    - The answer's candidates are rewritten to the `advertise()` addresses on `port`.
    - `datachannel` with label `api` goes to `serveChannel`. On session, it notes `relay` when the selected pair's local or remote candidate type is `relay`, otherwise `webrtc`.
  - `discoverPublicIpv4(stun: string, timeoutMs: number): Promise<string | null>`, plus a refresher that runs it at start and then hourly and updates `advertise()` (Review Focus 4).
  - `SignallingClient`: connects to `<RENDEZVOUS_URL>/signal/nas?nasId=`, answers the challenge, routes `offer`, `candidate` and `turn-request` to `RtcPeers`, and reconnects with backoff of 1 s doubling to 60 s.

- [ ] **Step 1: Write the failing tests.**
  - `public-address.test.ts`: a fake STUN responder on loopback UDP returns an XOR-MAPPED-ADDRESS, and the parse gives the IP. With a timeout and no answer, it gives null.
  - **The refresher's address change:** the advertised list changes when the fake answers a new address.
  - `peer.test.ts`:
    - A werift-to-werift loopback, with `advertise` `['127.0.0.1']` and port 47998 + test offset. A client opens the `api` channel through `WireClient`, does the session handshake and reads a disc range byte-exact.
    - The answer SDP contains only `127.0.0.1` host candidates, with no 172.x or 100.x addresses.
  - `signalling-client.test.ts`: against a fake WebSocket server, the NAS answers the challenge, routes an `offer` to `answer`, and reconnects after a drop.
- [ ] **Step 2: Run** `npx vitest run server/src/rtc`. Expect failures.
- [ ] **Step 3: Implement.** Wire it into `main.ts` only when `RENDEZVOUS_URL` is set. Check that `npm run server:build` bundles werift.
- [ ] **Step 4: Run** `npx vitest run server/src rendezvous/src`, `npm run typecheck` and `npm run server:build`. Everything passes.
- [ ] **Step 5: Commit** `feat(server): WebRTC peer on UDP 47998 with signalling and public-address discovery`.

### Task 5: The relay: TURN credentials, settings, usage

**Files:**
- Modify: `rendezvous/src/index.ts`, `rendezvous/src/protocol.ts` (`turnRequestMessage`, type tag `turn-credentials`), `server/src/rtc/peer.ts`, `server/src/routes/admin.ts`, `server/src/routes/titles.ts` (`me`)
- Create: `rendezvous/src/turn.ts`, `server/src/rtc/relay.ts`
- Test: `rendezvous/src/turn.test.ts`, `server/src/rtc/relay.test.ts`, `server/src/routes/admin.test.ts`

**Interfaces:**
- **Worker:** `POST /turn {nasId, ts, signature}`, where the signature covers `turnRequestMessage({nasId, ts})` and `ts` is within 60 s of now. The Worker calls Cloudflare's `POST https://rtc.live.cloudflare.com/v1/turn/keys/${TURN_KEY_ID}/credentials/generate-ice-servers` with `Authorization: Bearer ${TURN_KEY_API_TOKEN}` and `{ttl: 3600}`, and returns its `iceServers`.
  - It answers 503 `turn-not-configured` when the secrets are absent.
  - The implementer confirms the endpoint's current shape against Cloudflare's docs and records the date in the spec's §6.4.
- **NAS:** `class RelayState { constructor(dataDir, now); settings(): { enabled: boolean; allowPaid: boolean }; set(change): void; addBytes(n: number): void; usage(): { usedBytes: number; freeBytes: 1e12; resetsOn: string /* ISO date of next 1st, UTC */ }; mayRelay(): boolean }`. It keeps state in `/data/relay.json`, written atomically.
  - **Ruling P2-R1:** the NAS counts relayed bytes itself (both directions on relayed connections, sampled from werift stats every 10 s). The copy calls it an estimate. Reading Cloudflare's analytics would need another token; the spec allows this fallback.
- **Signalling:** on a `turn-request` from a device, the NAS answers `turn-response {iceServers}` only when:
  - `mayRelay()` is true, and
  - the device is either a known paired device whose signature over `{type:'turn', sid, ts}` verifies with its stored public key, or an unpaired device that sends the hash of a live invite code (spec §6.4).

  Otherwise it answers `{iceServers: [], reason: 'off' | 'limit' | 'unauthorized'}`.
- **Admin:** `GET admin/relay` returns `{enabled, allowPaid, usage}`, and `PUT admin/relay {enabled?, allowPaid?}` changes the settings.
- **`GET me`** gains `relay: { usedBytes, freeBytes, resetsOn } | null`, which is null when the relay is off.

- [ ] **Step 1: Write the failing tests.**
  - Worker: a good signature with a mocked Cloudflare fetch returns `iceServers`. A stale `ts` gets 401. Missing secrets get 503.
  - `relay.test.ts`:
    - Off by default, so `mayRelay` is false.
    - At 1e12 bytes `mayRelay` is false unless `allowPaid` is set.
    - Usage resets after the 1st of the next month on the fake clock.
  - **Admin routes:** owner only. A guest gets 403.
  - **TURN requests:**
    - With the relay off, the reason is `off`.
    - A paired device's good signature gets servers.
    - A forged signature is `unauthorized`.
    - A live invite's hash gets servers; an expired one is `unauthorized`.
- [ ] **Step 2: Run** `npx vitest run rendezvous/src server/src`. Expect failures.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same, plus `npm run typecheck`. Everything passes.
- [ ] **Step 5: Commit** `feat: optional Cloudflare relay with an owner switch, a monthly allowance and NAS-counted usage`.

### Task 6: The browser's connection and route choice

**Files:**
- Create: `src/ui/nas/rtc/rtc-connection.ts`, `src/ui/nas/rtc/signalling-client.ts`, `src/ui/nas/route-choice.ts`
- Modify: `src/ui/nas/nas-client.ts`, `src/ui/nas/nas-store.ts` (`NasPairing` gains `nasId?: string`; `base` stays the HTTPS base when known, else `''`)
- Test: `src/ui/nas/rtc/rtc-connection.test.ts`, `src/ui/nas/route-choice.test.ts`, `src/ui/nas/nas-client.test.ts`

**Interfaces:**
- Consumes Task 1's `WireClient`, Task 3's signalling messages and Task 5's TURN messages.
- Produces:
  - `class RtcConnection { static open(opts: { nasId; signallingUrl; deviceProof?: () => Promise<{deviceId; ts; signature}>; inviteHash?: string; createPeer?: () => RTCPeerConnection; openSocket?: (url) => WebSocket; timeoutMs?: number }): Promise<RtcConnection>; fetch: typeof fetch; relayed: boolean; onClose(cb): void; close(): void }`
    - It tries direct ICE first, using STUN only, for up to 8 s.
    - When that fails, it asks for TURN (`turn-request`) and retries once with the returned servers. With none, it rejects with `RtcUnreachable`, whose message is the "Can't connect…" copy.
    - `relayed` comes from the selected candidate pair.
  - `chooseRoute(pairing, deps): Promise<{ kind: 'https'; base } | { kind: 'webrtc'; connection: RtcConnection }>`. It applies the HTTPS-first, 2 s rule and caches the choice per NAS.
  - `RTC_BASE(nasId) = 'rtc://' + nasId + '/api/'`. `NasClient` builds URLs from the chosen base and routes `rtc://` URLs to the connection's `fetch`. Its existing session, token and error logic is unchanged.
  - **Closing** (Review Focus 2): when the connection closes, in-flight requests fail as `nas-lost`, and the next request runs `chooseRoute` again once.
  - **Pairing over WebRTC:** when the lookup has no HTTPS route, or HTTPS fails the 2 s check, `pair()` opens an `RtcConnection` with `inviteHash`, so the relay is allowed for the redeem, and redeems over it. The stored pairing keeps `nasId`, and `base` is `''` if HTTPS is unknown.
- `src/ui/nas/rtc/` may import from `src/engine/disc/rtc-wire.ts` (UI may import engine, not the reverse).

- [ ] **Step 1: Write the failing tests.** Use fakes for `RTCPeerConnection` and `WebSocket`, connected to a `WireServer` in memory.
  - Direct success means `relayed` is false.
  - Direct failure with TURN servers returned means a retry and `relayed` true.
  - No servers means `RtcUnreachable` with the exact copy.
  - `chooseRoute`:
    - HTTPS answering within 2 s means `https`;
    - HTTPS hanging means `webrtc` after 2 s, on a fake clock;
    - no HTTPS base means `webrtc` at once;
    - the choice is cached.
  - **NasClient over a fake connection:** pairing with a lookup that has only `webrtc`, `me()`, `library()`, and a closed connection mid-request giving `nas-lost`, with the next call reconnecting.
- [ ] **Step 2: Run** `npx vitest run src/ui/nas`. Expect failures.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/ui` and `npm run typecheck`. Everything passes.
- [ ] **Step 5: Commit** `feat(nas): WebRTC connection, HTTPS-first route choice, pairing over WebRTC`.

### Task 7: Discs over WebRTC: the engine and BD-J workers

**Files:**
- Modify:
  - `src/engine/disc/disc-spec.ts`: `RemoteDiscSpec` gains `fetchPort?: MessagePort`;
  - `src/engine/worker.ts` and `src/engine/player.ts`: when `fetchPort` is present, `deps.fetch` for this disc is `portFetch(fetchPort)`;
  - `src/engine/bdj/bdj-worker.ts` and the session that starts it: the engine worker makes a new `MessageChannel`, runs `serveFetch(port1, thisDiscFetch)` and passes `port2` to the BD-J worker, which uses `portFetch`;
  - `src/player/player-controller.ts` and `src/player/create-controller.ts`: transfer the port with the `open` command;
  - the UI caller that builds the remote disc spec (`src/ui/nas/`), which for a WebRTC route creates a `MessageChannel`, runs `serveFetch(port1, connection.fetch)` and puts `port2` in the spec.
- Test: `src/engine/player.test.ts` (a remote disc through `portFetch`), `src/engine/player-bdj.test.ts` (a BD-J disc through the relayed port), `tests/e2e/nas.spec.ts`, `tests/e2e/nas-server.ts`

**Interfaces:**
- Consumes `serveFetch`/`portFetch` (Task 1), `RtcConnection` and `chooseRoute` (Task 6), and the server pieces (Tasks 2–5).
- The engine sees no difference between routes except that its fetch comes from a port. `base` is `rtc://<nasId>/api/discs/<id>/`.

- [ ] **Step 1: Write the failing tests.**
  - `player.test.ts`: open a remote disc whose `fetch` is a `portFetch` served by the existing fake NAS. It plays and seeks, and the reads arrive.
  - `player-bdj.test.ts`: the BD-J worker reads its JARs through the relayed port.
  - **E2E:** `nas-server.ts` starts the real server with `RENDEZVOUS_URL` pointing at the Worker stand-in, which gains the signalling routes. It also sets `RTC_ADVERTISE=127.0.0.1` and `RTC_PORT=47990`. A new test in `nas.spec.ts`:
    - pairs from a fresh context whose HTTPS base is unreachable, with the stand-in's lookup returning only `webrtc`;
    - lands on the library, opens `disc1` and plays 3 s;
    - opens `disc-bdj` and reaches its first playlist.
    - Run it in chromium, firefox and webkit.
- [ ] **Step 2: Run** `npx vitest run src/engine/player.test.ts src/engine/player-bdj.test.ts` and `npm run build && E2E_PORT=4183 npx playwright test tests/e2e/nas.spec.ts --project=chromium`. Expect failures.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`, and `npm run build && E2E_PORT=4183 npx playwright test tests/e2e/nas.spec.ts` (all three desktop projects). Everything passes.
- [ ] **Step 5: Commit** `feat: discs and BD-J over the WebRTC route`.

### Task 8: Relay and route in the UI

**Files:**
- Modify: `src/ui/nas/AdminScreen.tsx`, `src/ui/nas/PeopleSection.tsx`, `src/ui/nas/people-model.ts`, `src/ui/nas/nas-client.ts` (admin `relay()` and `setRelay()`), the player's info line (find where the NAS route or disc facts are shown during play; `src/ui/PlayerScreen.tsx` or the NAS preflight), and `src/engine/protocol.ts` only if telemetry gains `route`
- Create: `src/ui/nas/relay-model.ts`
- Test: `src/ui/nas/relay-model.test.ts`, `src/ui/nas/people-model.test.ts`

**Interfaces:**
- `relay-model.ts`:
  - `usageLine(usage)` gives "Relay this month: 412 of 1,000 GB free", in whole GB rounded down, with a thousands separator.
  - `limitMessage(resetsOn, locale)` gives the exact copy.
  - `relaySettingsCopy` cites the date the terms were checked (from Task 5).
- **Admin:** a Relay section with an on/off switch, an "Allow paid use beyond the free allowance" switch and the usage line. Each device row shows its `lastRoute` as "Home or Tailscale", "WebRTC" or "WebRTC (relayed)".
- **While playing over a relayed connection:** a small "Relayed" badge, and the usage line from `me().relay`.
- Telemetry `nas: { route: 'https' | 'webrtc' | 'relay' }`, if `Telemetry` has a NAS block; otherwise add one.

- [ ] **Step 1: Write the failing tests.** The `usageLine` values are 0, 412.7 GB and 1,000 GB. Test the `limitMessage` copy and the `lastRoute` labels.
- [ ] **Step 2: Run** `npx vitest run src/ui/nas`. Expect failures.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/ui`, `npm run typecheck`, and the E2E with a relayed stand-in. The test can force `relayed` through a test-only `?rtcrelayed=1` flag read by `RtcConnection`, documented in CLAUDE.md like `?bdjfail=1`. Check that the badge shows. Everything passes.
- [ ] **Step 5: Commit** `feat(nas): relay switch, usage and route labels`.

### Task 9: Buffer first

**Files:**
- Create: `src/engine/disc/read-ahead-cache.ts`, `src/ui/nas/buffer-model.ts`
- Modify:
  - `src/engine/disc/remote-source.ts`: read from the cache first;
  - `src/engine/protocol.ts`: a `bufferAhead { fromSeconds: number; targetBytes: number }` command, a `cancelBuffer` command, and a `bufferProgress { bytes, targetBytes, mbps }` event;
  - `src/engine/player.ts`: fill the cache with the main playlist's clips in playback order from `fromSeconds`, using the EP map for the start offset;
  - `src/ui/nas/Preflight.tsx`;
  - `src/player/player-controller.ts`.
- Test: `src/engine/disc/read-ahead-cache.test.ts`, `src/ui/nas/buffer-model.test.ts`, `src/engine/player.test.ts`

**Interfaces:**
- `ReadAheadCache`:
  - `static open(discId: string, deps: { root: () => Promise<FileSystemDirectoryHandle>; now }): Promise<ReadAheadCache>`
  - `write(path: string, offset: number, bytes: Uint8Array): Promise<void>`
  - `read(path: string, offset: number, length: number): Promise<Uint8Array | null>`, which is null unless fully cached
  - `clearOthers(): Promise<void>`, which removes other discs and anything older than 24 h
  - It writes through `createSyncAccessHandle` in the worker. Ranges are tracked in a small JSON index per file.
- `buffer-model.ts`:
  - `bufferPlan({ durationS, playlistBytes, connectionMbps, quotaBytes })` returns `{ kind: 'play' } | { kind: 'silent'; waitS; bytes } | { kind: 'ask'; waitS; bytes } | { kind: 'too-big'; canHoldBytes; bytes }`, with the Global Constraints formula and threshold.
  - `waitCopy(waitS)` returns "About {n} minutes before it can play straight through", rounded up to a whole minute.
- **Pre-flight:**
  - `play` starts at once.
  - `silent` shows a progress ring, then plays.
  - `ask` shows Wait, Play now with pauses, and "Lower quality (coming later)" disabled.
  - `too-big` explains how much the device can hold and offers pauses (Review Focus 5).
  - Quota comes from `navigator.storage.estimate()`, after `navigator.storage.persist()`.

- [ ] **Step 1: Write the failing tests.**
  - `buffer-model.test.ts`, all with a 7200 s film at 30 Mbps average × 1.1 = 33 Mbps:
    - a connection at 40 Mbps gives `play`;
    - 32.5 Mbps gives `silent` with `waitS` ≈ 109.1;
    - 25 Mbps gives `ask` with `waitS` ≈ 1745.5;
    - a quota below the bytes gives `too-big`;
    - `waitCopy(1745)` is "About 30 minutes before it can play straight through".
  - `read-ahead-cache.test.ts`: on an in-memory `FileSystemDirectoryHandle` fake, write and read the same bytes, read a partial range as null, and clear by age and by disc.
  - `player.test.ts`: `bufferAhead` fills the cache from the EP-map offset for `fromSeconds` and emits progress, then the reads come from the cache (the fake fetch counts zero network reads). `cancelBuffer` stops it.
- [ ] **Step 2: Run** `npx vitest run src/engine/disc/read-ahead-cache.test.ts src/ui/nas/buffer-model.test.ts src/engine/player.test.ts`. Expect failures.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`, plus an E2E on chromium: a stand-in probe throttled to 5 Mbps against `disc1` shows `ask` with the copy, and Wait buffers, then plays. Everything passes.
- [ ] **Step 5: Commit** `feat: buffer first when the connection is slower than the disc`.

### Task 10: Docs, deploy, the device run

**Files:**
- Modify: `CLAUDE.md` (architecture paragraph for the WebRTC route, `?rtcrelayed=1`, the new commands and env), `docs/superpowers/specs/2026-10-18-webrtc-people-design.md` (status), `docs/known-issues.md` (an intercontinental measurement is still pending; the NAS counts relay usage as an estimate)

- [ ] **Step 1:** Run `npm test`, `npm run typecheck` and `npm run build`. Run the full NAS E2E on chromium, firefox and webkit. Everything passes.
- [ ] **Step 2:** Update the docs and commit `docs: the WebRTC route is in`.
- [ ] **Step 3 (controller, needs the user's approval):** merge to main and push. CI deploys the Worker (migration v2) and Pages. TURN secrets are optional: the relay answers `turn-not-configured` until the user adds them with `wrangler secret put` (ask the user; never echo them).
- [ ] **Step 4 (controller):** run `npm run server:deploy`. Check that health is 200, that the NAS log shows the signalling socket connected, and that the advertised public IPv4 is 99.110.49.153 or its current value.
- [ ] **Step 5 (controller, with the user):** the iPhone on cellular, with Tailscale OFF:
  - make an invite on the Mac's admin screen, open the link on the iPhone, and check that it pairs as a new person over WebRTC;
  - play a disc for 2 minutes, seek twice, then open a BD-J disc;
  - record throughput and route in the spec's status line.
  - Afterwards, remove the test person.
