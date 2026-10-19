# People and the Per-Person BD-J Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The NAS knows people. Every device and pairing code belongs to a person, owners are people, the admin screen manages people, and each person has a BD-J saved-data store that BD-J milestone 5e builds against.

**Architecture:**
- `auth.json` gains `people`, and devices and codes point at a person. Owner status is derived from the person and is migrated once from step 2's shape.
- A new `BdjStore` keeps each scope as one ustar file under `/data/users/<personId>/bdj/`, replaced atomically. Its etag comes from the file's identity (inode, mtime, size), so no sidecar can disagree with the data.
- New admin routes manage people. The app's admin screen gains a People section and a person picker for new codes.

**Tech Stack:** Node 24 + TypeScript (`server/`, bundled by `server/build.mjs`), Vitest, React (`src/ui/nas/`), Cloudflare Worker (`rendezvous/`), Playwright.

**Spec:** `docs/superpowers/specs/2026-10-18-webrtc-people-design.md`, §4 and §5 only. Release 1 of step 3. WebRTC, the relay and buffering (§6–§7) get their own plan after the spike.

## Global Constraints

- §5 is a contract with the BD-J session (5e builds against it). Status codes, headers, paths and limits are exactly as written there. Don't change any of it without a ledger ruling, and tell the controller.
- Scope keys: `persistent/<orgId>` and `buda/<orgId>/<discId>`. orgId is `/^[0-9a-f]{8}$/`, discId is `/^[0-9a-f]{32}$/`. Anything else is 400.
- Quotas: 16 MB (16 × 1024 × 1024 bytes) per scope, 256 MB per person. Over either returns 507 with JSON `{"error":"quota","limit":"scope"|"person"}`.
- GET on an empty scope returns 200 with an empty ustar archive (1024 zero bytes), `Content-Type: application/x-tar`, and no `ETag`.
- PUT needs `If-Match: "<etag>"` or `If-None-Match: *`. A mismatch is 412, and neither header is 428. DELETE needs `If-Match` and returns 204, or 412.
- Tar entries must be regular files (typeflag `0` or NUL) with relative paths, no `..` segment, no leading `/`, and names of 255 bytes or less (ustar prefix plus name). Anything else is 400. The server never extracts to disk.
- Everything is written under the data dir (`/data`) only. Never write under `/mnt`. Caddy is reloaded only, never restarted. The repo is public, so use made-up names in tests ("Owner", "Mika", "Starfall Wanderer").
- Plain pairing codes last 10 minutes and invites 3 days (`INVITE_TTL_MS = 3 * 24 * 60 * 60_000`). The rendezvous Worker accepts expiries up to 3 days plus 1 hour ahead.
- Migration (spec §4.1): all step-2 owner devices go to one person named `Owner` (owner). Each non-owner device becomes its own person, named after the device. Live owner codes go to the `Owner` person, and live non-owner codes are dropped.
- The last-owner invariant: an admin action that would leave no device belonging to an owner person returns 409 `{"error":"last-owner"}`. This covers revoking a device, moving a device, unmaking an owner and removing a person.
- No native dependencies in the server (the tar reader and writer are hand-written).

## Review Focus

1. **The real step-2 `auth.json`** (owner devices plus a live non-owner code) has to load, migrate once and keep every owner device working. A failed migration locks the user out of the admin screen. Covered in Task 1.
2. **Two devices of one person PUT the same scope at once** (iPad and iPhone). Exactly one succeeds, the other gets 412, and the file is never half-written. Covered in Task 2.
3. **A hostile or broken tar** (traversal, symlink, a declared size beyond the body, a body cut off mid-entry) gets a 400 and nothing is written. Covered in Task 2.
4. **A chunked PUT with no Content-Length that grows past 16 MB** gets a 507 once it passes the limit, and leaves no temp file behind. Covered in Task 3.
5. **A device whose person was removed while it holds a valid session token** gets a 401 on its next request, on every route. Covered in Task 1 (verify) and Task 3 (route).

---

### Task 1: People in the auth store, with migration

**Files:**
- Modify: `server/src/auth.ts`, `server/src/store.ts`
- Test: `server/src/auth.test.ts`, new `server/src/store.test.ts`

**Interfaces:**
- Produces, in `auth.ts`:
  - `interface Person { readonly id: string; name: string; owner: boolean; readonly createdAt: number }`
  - `interface StoredDevice { readonly id; name; personId: string; readonly publicKeyJwk; readonly pairedAt; lastSeen }` (no `owner`)
  - `interface Device extends StoredDevice { readonly owner: boolean; readonly personName: string }` (what `verify`, `devices()` and `redeem` return, with `owner` derived from the person)
  - `interface PairingCode { readonly id; readonly hash; readonly personId: string; readonly invite: boolean; readonly expiresAt }`
  - `type PersonRef = { personId: string } | { newPerson: { name: string; owner: boolean } }`
  - `Auth`:
    - `createCode(person: PersonRef, opts?: { invite?: boolean }): { record: PairingCode; code: string; person: Person }`
    - `people(): Person[]`
    - `createPerson(name: string, owner: boolean): Person`
    - `updatePerson(id: string, change: { name?: string; owner?: boolean }): Person`, which throws `AuthConflict('last-owner')`, or `AuthNotFound`
    - `removePerson(id: string): void`, which revokes their devices, throws as above, and does not touch saved data (Task 4 does)
    - `moveDevice(deviceId: string, personId: string): void`, which throws as above
    - `revokeDevice(id)`, which now throws `AuthConflict('last-owner')` itself
    - `firstOwnerPerson(): Person`, which creates `Owner` if there is none
  - Export `class AuthConflict extends Error { constructor(readonly reason: 'last-owner') }` and `class AuthNotFound extends Error`.
- Produces, in `store.ts`: `AuthData { people: Person[]; devices: StoredDevice[]; codes: PairingCode[] }`. `Store.read()` and `Store.update()` see only the migrated shape.

- [ ] **Step 1: Write the failing tests**
  - `store.test.ts`:
    - `migrates a step-2 file once`: write `{devices:[{…owner:true}, {…owner:true}, {…name:'Den TV',owner:false}], codes:[{…owner:true, live}, {…owner:false, live}]}`.
      - `read()` has `people` = `[{name:'Owner',owner:true}, {name:'Den TV',owner:false}]`.
      - Both owner devices have the `Owner` id.
      - `codes` has one entry, with `personId` = Owner and `invite: false`.
      - The file on disk now has `people` (it was rewritten under the lock).
      - A second `new Store(dir).read()` returns the same ids (not migrated again).
    - `rejects a migrated file whose device names an unknown person` with `/is corrupt/`.
  - `auth.test.ts`:
    - `codes name their person`: `createCode({newPerson:{name:'Mika',owner:false}})`, then redeem. The device has `personName 'Mika'` and `owner false`.
    - `invite codes last 3 days`: `expiresAt === now + 3*24*60*60_000`.
    - `owner is derived from the person`: `updatePerson(mika.id,{owner:true})`, and `verify(token).owner === true`.
    - `last-owner is refused` for each of `revokeDevice`, `moveDevice` (the owner's only device to Mika), `updatePerson(owner,{owner:false})` and `removePerson(owner)`. Each throws `AuthConflict` with `reason 'last-owner'`.
    - `removing a person revokes their devices`: Mika's token's `verify` is `null` afterwards.
    - `firstOwnerPerson makes Owner once`.
- [ ] **Step 2: Run** `npx vitest run server/src/store.test.ts server/src/auth.test.ts`. Expect failures (no `people`).
- [ ] **Step 3: Implement.**
  - **Migration** happens in `Store.load()`. Detect the step-2 shape (no `people` key), migrate it, and have the `Store` constructor persist it under `lockFile` with `replaceAtomically`.
  - **Validation:** `validate()` also checks `people` and `personId` references.
  - **Last-owner check:** one private `ownerDeviceCount(data)` helper, checked inside the same `store.update` that makes each change, so the check and the write are atomic.
  - **Renaming:** person names are trimmed, 1–100 characters, otherwise `HttpError`-free `RangeError` (routes map it to 400).
  - **Old callers:** update the existing callers of `createCode({owner})` (`cli.ts`, `routes/admin.ts`) only enough to compile: owner codes use `firstOwnerPerson()`. Task 3 replaces them.
- [ ] **Step 4: Run** `npx vitest run server/src` and `npm run typecheck`. Everything passes.
- [ ] **Step 5: Commit** `feat(server): people own devices and pairing codes, migrated from step 2`.

### Task 2: ustar archives and the BD-J store

**Files:**
- Create: `server/src/tar.ts`, `server/src/bdj-store.ts`
- Test: `server/src/tar.test.ts`, `server/src/bdj-store.test.ts`

**Interfaces:**
- Produces, in `tar.ts`:
  - `EMPTY_TAR: Buffer` (1024 zero bytes)
  - `interface TarEntry { path: string; size: number; mtime: number }`
  - `listTar(archive: Buffer): TarEntry[]`, which throws `TarError` (exported) on any rule in Global Constraints, on a size past the buffer, on a missing end, or on a bad header checksum
  - `writeTar(files: { path: string; data: Buffer; mtime: number }[]): Buffer` (for tests and 5e's reference)
- Produces, in `bdj-store.ts`:
  - `parseScope(raw: string): string | null`, which returns the normalized scope or null
  - `class BdjStore`, with `constructor(dataDir: string)`:
    - `get(personId, scope): { etag: string | null; body: Buffer }`
    - `put(personId, scope, body: Buffer, cond: { ifMatch?: string; ifNoneMatch?: boolean }): { etag: string }`, which throws `StoreError('precondition'|'quota-scope'|'quota-person'|'bad-archive')`
    - `delete(personId, scope, ifMatch: string): void`
    - `usage(personId): number` (bytes)
    - `clear(personId): void` (removes `/data/users/<personId>/` entirely)
  - The constants `SCOPE_LIMIT_BYTES` and `PERSON_LIMIT_BYTES`.
- Files: `<dataDir>/users/<personId>/bdj/persistent/<orgId>.tar` and `<dataDir>/users/<personId>/bdj/buda/<orgId>/<discId>.tar`.
- Etag: base64url of the first 12 bytes of SHA-256 over `${ino}:${mtimeMs}:${size}` of the scope file, quoted on the wire by the route.
  - **Ruling:** the spec mentions a sidecar etag, but the builder sets its format. A stat-derived etag can't disagree with the data after a crash, and a rename always gives a new inode.

- [ ] **Step 1: Write the failing tests**
  - `tar.test.ts`:
    - A round trip of `writeTar` → `listTar` keeps paths, sizes and mtimes.
    - `listTar(EMPTY_TAR)` is `[]`.
    - Each of these is a `TarError`: `../x`, `/abs`, `a/../../b`, a symlink (typeflag `2`), a directory (`5`), a size past the end, a bad checksum, a truncated body, and a 300-byte path.
  - `bdj-store.test.ts`:
    - `parseScope` accepts `persistent/0a1b2c3d` and `buda/0a1b2c3d/<32 hex>`. It rejects uppercase hex, a 7-digit orgId, `buda/0a1b2c3d`, `persistent/0a1b2c3d/x` and `../`.
    - The first `get` is `{etag:null, body: EMPTY_TAR}`.
    - `put` with `ifNoneMatch` returns an etag, and `get` returns the same body and etag.
    - A second `ifNoneMatch` put → `precondition`.
    - A put with a stale `ifMatch` → `precondition`.
    - **Concurrent writers:** two puts with the same `ifMatch` → exactly one succeeds.
    - A put whose archive is 16 MB + 1 byte → `quota-scope`.
    - Puts reaching 256 MB across scopes → `quota-person`. Use 17 scopes of 16 MB minus a header, and make the test's limits injectable through a constructor option `{ scopeLimit, personLimit }` so it runs on kilobytes.
    - A bad archive → `bad-archive` and no file.
    - **Crash between temp write and rename:** a leftover `*.tmp` file doesn't change `get`.
    - `clear` removes the person's folder.
    - `usage` sums the person's `.tar` sizes.
- [ ] **Step 2: Run** `npx vitest run server/src/tar.test.ts server/src/bdj-store.test.ts`. Expect failures.
- [ ] **Step 3: Implement.**
  - Write the archive with `writeSynced` to `<file>.<pid>.<random>.tmp`, then rename, then `syncDir`.
  - Do the precondition check, quota check and rename under `lockFile(<file>)` from `atomic-json.ts`, so concurrent puts serialize.
  - `usage` walks `users/<id>/bdj` and ignores `*.tmp`.
- [ ] **Step 4: Run** the same tests, then `npx vitest run server/src`. Everything passes.
- [ ] **Step 5: Commit** `feat(server): per-person BD-J store of ustar scopes`.

### Task 3: Routes: people admin, codes per person, invites, the BD-J store

**Files:**
- Modify: `server/src/routes/admin.ts`, `server/src/routes/pair.ts`, `server/src/routes/titles.ts` (`me`), `server/src/app.ts`, `server/src/main.ts`, `server/src/cli.ts`, `server/src/cors.ts`, `src/engine/disc/cors-policy.ts`, `server/deploy/deploy.sh`, `rendezvous/src/protocol.ts`
- Create: `server/src/routes/bdj-store.ts`
- Test: `server/src/routes/admin.test.ts` (create if absent, else extend `auth.test.ts`'s route tests where admin is tested today), `server/src/routes/bdj-store.test.ts`, `server/src/cors.test.ts`, `rendezvous/src/worker.test.ts`

**Interfaces:**
- Consumes Task 1's `Auth` API and Task 2's `BdjStore` and `parseScope`.
- Produces these HTTP routes (all JSON, owner token for `admin/*`):
  - `GET admin/people` → `{ people: [{ id, name, owner, createdAt, savedBytes, devices: [{ id, name, pairedAt, lastSeen }] }] }`
  - `POST admin/people {name, owner?}` → 201 with the person
  - `PATCH admin/people/:id {name?, owner?}` → 200 with the person, or 404 / 409 `last-owner` / 400
  - `DELETE admin/people/:id` → 204. It calls `bdjStore.clear(id)` after `auth.removePerson`.
  - `DELETE admin/people/:id/saved-data` → 204
  - `PATCH admin/devices/:id {personId}` → 204, or 404 / 409
  - `DELETE admin/devices/:id` → 204, or 409 from `AuthConflict`
  - `POST admin/codes {personId} | {newPerson:{name,owner}}`, plus `invite?: boolean` → `{ code, link, expiresAt, rendezvous, personId, personName, invite }`
  - `GET admin/codes` → `{ codes: [{ id, personId, personName, invite, expiresAt }] }`
  - `GET admin/devices` keeps working, with `personId` and `personName` added.
  - `POST pair/redeem` → `{ deviceId, owner, personId, personName }`
  - `GET me` → `{ owner, titleLibrary, personId, personName }`
  - `GET|PUT|DELETE bdj-store/<scope…>` (device token, `Authorization: Bearer` or `t=`), as in Global Constraints. The body is read as a stream and refused with 507 once it passes `SCOPE_LIMIT_BYTES`, whether or not `Content-Length` was sent (a declared `Content-Length` over the limit is refused before reading). The response's `ETag` is quoted.
- CORS:
  - `Access-Control-Allow-Headers` adds `If-Match, If-None-Match`.
  - `corsHeaders` adds `Access-Control-Expose-Headers: ETag`.
- CLI: `node server.mjs owner-code [--person <name>]`. Without `--person` it uses `firstOwnerPerson()`. With `--person` it uses the owner person of that name, creating it if needed. It prints the person's name. `deploy.sh --owner-code` passes on any extra args.
- Rendezvous: `MAX_CODE_AHEAD_MS = 3 * 24 * 60 * 60_000 + 60 * 60_000`.

- [ ] **Step 1: Write the failing tests.** Use the existing server test harness (`appHandlers` with a temp data dir, as `titles.test.ts` does).
  - People CRUD and the 409s.
  - `POST admin/codes` with `newPerson` makes the person.
  - `invite:true` gives `expiresAt` = now + 3 days.
  - `redeem` and `me` carry `personName`.
  - A guest gets 403 on `admin/people`.
  - **Removed person:** after `DELETE admin/people/:id`, that person's token gets 401 on `bdj-store/...` and on `GET library`.
  - **bdj-store:** empty GET, `ETag` round trip, 412, 428, 400 on bad scope, 400 on a bad archive, 507 on a 16 MB + 1 byte chunked body with no Content-Length (and no `*.tmp` file left), and 401 without a token.
  - **Isolation:** two people's stores are separate; the same scope gives different bodies.
  - **CORS:** an `OPTIONS` preflight allows `If-Match`, and a GET response exposes `ETag`.
  - **Worker:** an expiry 3 days ahead is accepted, and 3 days + 2 hours is 400.
- [ ] **Step 2: Run** `npx vitest run server/src rendezvous/src`. Expect the new tests to fail.
- [ ] **Step 3: Implement.**
  - **Routing:** `bdjStoreRoutes(auth, store)` sits after `requireToken` in `appHandlers`. `main.ts` builds `new BdjStore(config.dataDir)`. The three-segment admin route `people/:id/saved-data` goes next to the existing `discs/:id/choice` handling.
  - **Rendezvous registration:** pass the code's own `expiresAt` to the registrar, as now.
- [ ] **Step 4: Run** `npx vitest run server/src rendezvous/src`, `npm run typecheck` and `npm run server:build`. Everything passes, and the bundle builds.
- [ ] **Step 5: Commit** `feat(server): people admin, per-person codes and invites, BD-J store routes`.

### Task 4: The app: people on the admin screen, codes for a person

**Files:**
- Modify: `src/ui/nas/nas-client.ts`, `src/ui/nas/admin-model.ts`, `src/ui/nas/AdminScreen.tsx`, `src/engine/disc/nas-api.ts` (shared types, if `NasDevice`/`NasCode` live there; otherwise in `nas-client.ts`)
- Create: `src/ui/nas/PeopleSection.tsx`, `src/ui/nas/people-model.ts`
- Test: `src/ui/nas/people-model.test.ts`, `src/ui/nas/nas-client.test.ts`, `src/ui/nas/admin-model.test.ts`, `tests/e2e/nas.spec.ts`

**Interfaces:**
- Consumes Task 3's routes.
- Produces:
  - `NasClient.admin`:
    - `people(): Promise<NasPerson[]>`
    - `createPerson(name, owner)`
    - `updatePerson(id, change)`
    - `removePerson(id)`
    - `clearSavedData(id)`
    - `moveDevice(id, personId)`
    - `createCode(target: { personId: string } | { newPerson: { name: string; owner: boolean } }, invite: boolean)`
  - `NasMe` and `NasPairing` gain `personName`. The stored pairing gains `personName`, and old stored pairings without it stay valid (`personName` optional on read).
  - `people-model.ts`:
    - `personRows(people, now, thisDeviceId)`, giving name, owner badge, a devices line with last seen, and saved data formatted as `"1.2 MB"`, or `"none"` when 0
    - `removePersonQuestion(person)`, which names the devices and the saved data that go
    - `lastOwnerMessage`, which reads `"At least one owner device has to stay. Make someone else an owner first."`
- UI:
  - The People section replaces the Devices list. Each person shows their devices, with **Rename**, **Make owner/Remove owner**, **Clear saved data** (only when savedBytes > 0), **Remove** (with confirmation) and, per device, **Move to…** and **Revoke**.
  - The "New pairing code" dialog gains a person picker: the existing people, plus "New person…" with a name field and an "Owner" checkbox, which replaces today's `nas-owner-code` checkbox.
  - It also gains a "Send as an invite (valid 3 days)" toggle. The code view says the lifetime and the person.
  - Keep `data-testid`s: `nas-person-<name>`, `nas-code-person`, `nas-code-invite`, `nas-new-person-name`, `nas-new-person-owner`.
- The landing and pairing confirmation say "Paired as <personName>".

- [ ] **Step 1: Write the failing tests.**
  - `people-model.test.ts`: the rows, size formatting, the remove question naming two devices and "1.2 MB of saved data", and the last-owner message.
  - `nas-client.test.ts`: each new admin call's method, path and body, and an old stored pairing without `personName` still loading.
  - `nas.spec.ts`: rewrite the test that uses `nas-owner-code`. The owner makes a code for a new person `Mika` (not an owner) as an invite. A second browser context pairs with it and sees "Paired as Mika". The owner's People section lists Mika with one device, then removes Mika, and Mika's context is sent back to pairing on its next request.
- [ ] **Step 2: Run** `npx vitest run src/ui/nas` (failing) and `npx playwright test tests/e2e/nas.spec.ts --project=chromium` (failing on the new flow).
- [ ] **Step 3: Implement.** Follow the existing AdminScreen patterns: pure model functions, and confirmations as the "file differently" screens do.
- [ ] **Step 4: Run** `npx vitest run src/ui/nas`, `npm run typecheck` and `npx playwright test tests/e2e/nas.spec.ts` (all projects). Everything passes.
- [ ] **Step 5: Commit** `feat(nas): people on the admin screen, codes and invites for a person`.

### Task 5: Docs, deploy and hand-off

**Files:**
- Modify: `CLAUDE.md` (the NAS server paragraph: people, `owner-code --person`, the BD-J store, `/data/users`), `docs/superpowers/specs/2026-10-18-webrtc-people-design.md` (status line: release 1 done)

- [ ] **Step 1:** Run `npm test`, `npm run typecheck`, `npm run build` and `npx playwright test tests/e2e/nas.spec.ts`. Everything passes.
- [ ] **Step 2:** Update the docs and commit `docs: people and the BD-J store are in`.
- [ ] **Step 3 (controller, needs the user's approval):** merge to main and push. CI deploys the rendezvous Worker with the 3-day expiry.
- [ ] **Step 4 (controller):**
  - Back up the NAS's `auth.json`: `ssh mediaserver docker exec bluray-server cp /data/auth.json /data/auth.json.pre-people`.
  - Then run `npm run server:deploy`.
  - Check `ssh mediaserver docker exec bluray-server node -e` to read `people` from `/data/auth.json` and print only the count of people and devices per person. No keys.
  - Check that `/bluray/api/health` is 200 and that the user's iPhone still opens the library.
- [ ] **Step 5 (controller):** tell the BD-J session (`bluray-web-47`) that people and the store are deployed, with the commit.
