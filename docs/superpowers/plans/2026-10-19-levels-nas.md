# Lower Quality on the NAS: Phase 1 (the NAS Side) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The NAS serves every disc at re-encoded quality levels as alternative versions of the disc (manifest, CLPI, MPLS and stream files), encoded live on Quick Sync ahead of the reader, cached, and admitted within the GPU's capacity. The client transport can request a level and retries while the NAS encodes.

**Architecture:** A level is computed from the original CLPI alone:
- every EP interval gets a fixed byte budget, so sizes and the rewritten EP map are known before encoding;
- a per-clip encoder (ffmpeg, hardware decode and encode, keyframes forced at EP PTS) produces the video;
- a re-muxer interleaves it with the interval's kept non-video packets and pads with nulls to the budget;
- a level service maps range reads to intervals, drives encoders ahead of the reader, caches finished intervals under `/data/transcode`, and leases GPU capacity per viewing.

**Tech Stack:**
- Node 24 + TypeScript (`server/`, esbuild bundle);
- ffmpeg as a child process: jellyfin-ffmpeg with iHD on the NAS, libx264 in CI;
- Vitest;
- the existing BDMV parsers in `src/engine/bdmv/`.

**Spec:** `docs/superpowers/specs/2026-10-19-lower-quality-design.md`, §2, §3, §5, §6, §8 and §9. Phase 2 (§7: the pre-flight choice, the Quality menu, the engine's `setLevel`, capability checks) waits for BD-J 5e's MPEG-2/VC-1 merge and gets its own plan.

## Global Constraints

- **Levels** (`LevelId`):
  - `original`
  - `h264-1080` (target 8 Mbps, maxrate ×1.25)
  - `phone-720` (720p H.264, target 3 Mbps)
  - `hevc-1080` (target 5 Mbps)
  - for UHD HDR sources: `hevc-1080-hdr` (Main10, HDR10 metadata kept) and `h264-1080-sdr` (tone-mapped with `vpp_qsv`)
- **Budget per EP interval:**
  - ⌈ duration × (video peak + kept audio's nominal rate + 1.5 Mbps graphics allowance) ÷ 8 ÷ 6144 ⌉ × 6144 bytes;
  - video peak = target × 1.25;
  - the kept audio's nominal rate comes from its first frame header.
- **What a level carries:**
  - the primary video, re-encoded;
  - one audio stream, chosen by the request, reduced to its core: TrueHD to AC-3, DTS-HD to the DTS core, AC-3 and DTS as they are, LPCM kept;
  - every PG and IG stream, bit-exact.
- **What a level drops:** secondary video, the MVC dependent view, the Dolby Vision enhancement layer, other audio and secondary audio. The CLPI program info and the MPLS STN tables lose those entries too.
- **Keyframes and interlacing:**
  - every EP entry's PTS gets an IDR (`-forced_idr 1`, `-copyts`);
  - interlaced sources are deinterlaced to the frame rate, and pulldown is removed to 23.976p where flagged.
- **Live encoding:**
  - the encoder runs 120 s of film ahead of the furthest read;
  - it stops 60 s after the last read;
  - a read waiting longer than 15 s gets 503 with `Retry-After: 1`.
- **Cache:** `/data/transcode/<discId>/<level>/<audio>/<clip>/`, LRU 50 GB (50 × 1024³ bytes), keyed by the clip's size and mtime.
- **Capacity:**
  - two encoder-fps budgets: H.264 190 fps and HEVC 100 fps;
  - a viewing needs its output fps × 1.3;
  - a lease is per viewing, held across seeks, encoder restarts and audio switches;
  - a lease is released on close, or after 2 min without a read;
  - first come, first served.
- **Copy:**
  - "The NAS is busy re-encoding for others. This will play at original quality."
  - "The NAS is busy. Try again in a few minutes." (MPEG-2/VC-1 discs)
- **Container:**
  - the image ships ffmpeg as a separate binary;
  - compose passes `/dev/dri/renderD128` with `group_add: ["993"]`;
  - with no GPU, or a failing self-test at start, only `original` is offered, and `GET me` has `levels: false`.
- **Constraints carried over:**
  - Never write under `/mnt`; the drives stay read-only. Caddy is reloaded only.
  - The repo is public: made-up names in fixtures and tests.
  - The server stays plain Node with no addons.
  - Only `src/engine/disc/` may change in the engine in this phase, not demux, decode or player.

## Review Focus

1. **An interval whose encode overflows its budget.** It must be re-encoded at a lower rate before it is served, never served truncated or oversized, and the file size must never differ from the manifest. Covered in Task 4 and Task 5.
2. **A seek far ahead of the encoder, then back.** The encoder restarts at the EP entry at or before the seek, earlier cached intervals stay valid, and the reader never gets bytes from the wrong interval. Covered in Task 6.
3. **A disc whose video is MPEG-2 or VC-1.** Its levels rewrite the coding type in both CLPI and MPLS, and the engine's own parsers read them back as H.264. Covered in Task 2.
4. **A clip with TrueHD, DTS-HD MA, a commentary track and three PG streams.** The level keeps exactly the chosen audio's core plus all PG and IG, and the others are gone from the TS, CLPI and STN. Covered in Task 2 and Task 4.
5. **The NAS with no `/dev/dri`**, for example a kernel regression. The server starts, offers only `original`, and says so; it never crashes or hangs on a read. Covered in Task 7.

---

### Task 1: Synthetic fixture discs for levels

**Files:**
- Create: `scripts/make-level-discs.ts`
- Modify: `package.json` (`fixture:synthetic` also runs it), `tests/helpers/ts-muxer.ts`, `tests/helpers/bdmv-builders.ts` (only as needed to emit MPEG-2 video (0x02), an interlaced H.264 stream, AC-3 plus a TrueHD-shaped PID with AC-3 core frames, and PG)
- Generate: `fixtures/synthetic/disc-mpeg2/` and `fixtures/synthetic/disc-levels/`

**Interfaces:**
- **Produces:**
  - **`disc-mpeg2`:** 1080i MPEG-2 video, 10 s, EP entries every 1.001 s, one AC-3 track.
  - **`disc-levels`:** 1080p H.264, 10 s, with two audio tracks (one TrueHD with AC-3 core, one AC-3 commentary), one secondary-video PID listed in the STN, and two PG streams.
  - Made-up names only.

- [ ] **Step 1:** Write the generator using ffmpeg (`mpeg2video`, `libx264`, `ac3`) and the existing muxer helpers. Check each disc with the engine's parsers in a small test, `tests/fixtures-levels.test.ts`:
  - `parseClpi` lists the expected coding types (0x02, 0x1B, 0x83, 0x81, 0x90, …);
  - the EP map has 10 entries ±1;
  - `parseMpls` lists the STN entries.
- [ ] **Step 2:** Run `npm run fixture:synthetic` and `npx vitest run tests/fixtures-levels.test.ts`. Expect PASS.
- [ ] **Step 3:** Commit `test: synthetic MPEG-2 and multi-track discs for quality levels`.

### Task 2: Level arithmetic and the CLPI/MPLS rewrite

**Files:**
- Create: `server/src/levels/levels.ts`, `server/src/levels/clpi-writer.ts`, `server/src/levels/mpls-writer.ts`
- Test: `server/src/levels/levels.test.ts`, `server/src/levels/clpi-writer.test.ts`, `server/src/levels/mpls-writer.test.ts`

**Interfaces:**
- **Consumes:** `parseClpi`, `parseMpls` and their types from `src/engine/bdmv/`.
- **Produces, in `levels.ts`:**
  - `type LevelId = 'original' | 'h264-1080' | 'phone-720' | 'hevc-1080' | 'hevc-1080-hdr' | 'h264-1080-sdr'`
  - `interface LevelDef { id; codec: 'h264' | 'hevc'; width: number; height: number; targetBps: number; peakBps: number; hdr: boolean; tonemap: boolean }`
  - `LEVELS: Record<Exclude<LevelId,'original'>, LevelDef>`
  - `levelsFor(source: { codingType: number; height: number; hdr: boolean }): LevelId[]`
  - `interface IntervalPlan { index: number; startPts45: number; endPts45: number; srcSpnStart: number; srcSpnEnd: number; budgetBytes: number; spnStart: number }`
  - `planClip(clpi: Clpi, level: LevelDef, audioBps: number): { intervals: IntervalPlan[]; sizeBytes: number }`
- **Produces, in `clpi-writer.ts`:** `rewriteClpi(original: Uint8Array, plan: {intervals; level: LevelDef; keepPids: number[]; videoPid: number; newCoding: number; newFormat: number; newRate: number}): Uint8Array`. It regenerates the video EP map (coarse/fine) from the plan's SPNs and PTS, drops dropped streams from program info, sets the video coding type, format and rate, sets `numSourcePackets`, and fixes every section offset.
- **Produces, in `mpls-writer.ts`:** `rewriteMpls(original: Uint8Array, keep: { audioStreamNumber: number }, video: { newCoding: number; newFormat: number; newRate: number }): Uint8Array`. It drops secondary video, the other primary audio and secondary audio from every play item's STN, and rewrites the primary video's coding attributes.

- [ ] **Step 1: Failing tests.**
  - `levels.test.ts`:
    - the budget formula, for a 1.001 s interval, `h264-1080`, 640 kbps audio: ⌈1.001 × (10e6 + 640e3 + 1.5e6)/8/6144⌉ × 6144;
    - sizes are the sum of the budgets, and SPNs are cumulative ÷ 192;
    - `levelsFor` on MPEG-2 1080 has no `original`-only result, and UHD HDR gets the two HDR levels.
  - `clpi-writer.test.ts`:
    - rewriting `disc-mpeg2`'s CLPI and parsing it back with `parseClpi` gives video coding 0x1B, EP entries at the same PTS with the planned SPNs, and `numSourcePackets` equal to the plan's size ÷ 192;
    - on `disc-levels`, the dropped PIDs are gone and PG and IG stay;
    - a round trip with `level=original` is byte-identical (no-op path).
  - `mpls-writer.test.ts`: `parseMpls` of the rewritten MPLS has one primary audio (the chosen number), no secondary video, both PG, and video coding 0x1B (Review Focus 3, 4).
- [ ] **Step 2:** Run `npx vitest run server/src/levels`. Expect FAIL.
- [ ] **Step 3:** Implement. Write the binary writers against the BD spec's structure as the engine's parsers read it, and keep untouched sections byte-copied.
- [ ] **Step 4:** Run the same, plus `npm run typecheck`. Expect PASS.
- [ ] **Step 5:** Commit `feat(server): quality levels: budgets, rewritten CLPI and MPLS`.

### Task 3: Audio cores and the kept-stream filter

**Files:**
- Create: `server/src/levels/audio-core.ts`
- Test: `server/src/levels/audio-core.test.ts`

**Interfaces:**
- **Produces:**
  - `class PesCoreFilter { constructor(codingType: number); push(pes: Uint8Array): Uint8Array | null }`. TrueHD (0x83) keeps only the AC-3 sync frames (0x0B77); DTS-HD (0x85, 0x86) keeps only the core frame (0x7FFE8001) and drops the extension substream. Others pass through.
  - `nominalAudioBps(codingType: number, firstFrame: Uint8Array): number`
  - `class KeptStreams { constructor(keepPids: Set<number>, coreFilters: Map<number, PesCoreFilter>); filter(packet: Uint8Array /* 192 B */): Uint8Array[] }`. It returns the packets to keep, rebuilt where a PES shrank. PAT and PMT are regenerated without the dropped PIDs; that is `pmtFor(keepStreams)`.

- [ ] **Step 1: Failing tests.** On `disc-levels`:
  - the TrueHD PID filtered yields only AC-3 frames that `src/engine/decode/audio-frames.ts`'s framer accepts;
  - a DTS-HD sample (build a minimal core plus an extension frame in the test) keeps the core bytes exactly;
  - the PMT lists only the kept PIDs;
  - `nominalAudioBps` reads 640000 from an AC-3 640 kbps header.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expect PASS.
- [ ] **Step 5:** Commit `feat(server): keep one audio track's core and the graphics streams`.

### Task 4: The re-muxer

**Files:**
- Create: `server/src/levels/remux.ts`
- Test: `server/src/levels/remux.test.ts`

**Interfaces:**
- **Consumes:** `IntervalPlan` (Task 2) and `KeptStreams` (Task 3).
- **Produces:** `remuxInterval(input: { plan: IntervalPlan; keptPackets: Uint8Array[] /* in original order, with their original ATS */; video: { pes: Uint8Array; dts90: number }[]; videoPid: number; firstAts: number }): { bytes: Uint8Array } | { overflow: number }`.
  - It interleaves video PES (packetized onto `videoPid`, PCR carried on video as the original did, or on the original PCR PID if kept) by DTS with the kept packets, which keep their relative positions.
  - It rewrites ATS monotonically across the interval.
  - It pads with null packets (PID 0x1FFF, valid TP_extra_header) to exactly `budgetBytes`.
  - It returns `overflow` (the excess bytes) when the content doesn't fit.

- [ ] **Step 1: Failing tests.**
  - The output length is exactly the budget.
  - Every 192 B packet has sync 0x47 at offset 4.
  - Kept packets appear in their original order.
  - Demuxing the output with `src/engine/demux/` gives the video PES (same bytes, same DTS) and the audio and PG PES unchanged.
  - ATS is non-decreasing.
  - An over-full input returns `overflow > 0` and no bytes (Review Focus 1).
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expect PASS.
- [ ] **Step 5:** Commit `feat(server): re-mux an EP interval to its byte budget`.

### Task 5: The encoder and the segment cache

**Files:**
- Create: `server/src/levels/encoder.ts`, `server/src/levels/segment-cache.ts`
- Test: `server/src/levels/encoder.test.ts`, `server/src/levels/segment-cache.test.ts`

**Interfaces:**
- **Produces, in `encoder.ts`:**
  - `interface EncoderBackend { args(input: { file: string; startPts90: number; keyframesPts90: number[]; level: LevelDef; interlaced: boolean; hdr: boolean; rateBps: number }): string[]; binary: string }`
  - `qsvBackend` (the spike's commands: `-hwaccel qsv -hwaccel_output_format qsv`, `scale_qsv` or `vpp_qsv` with deinterlacing and tone-mapping as the level needs, `h264_qsv`/`hevc_qsv` with `-preset medium` (`veryfast` for HEVC), `-forced_idr 1`, `-copyts`, output elementary TS to stdout)
  - `x264Backend` (libx264, for CI)
  - `class ClipEncoder { constructor(backend, opts); start(fromInterval: number): void; stop(): void; on('interval', (index, video: {pes; dts90}[]) => void); on('error', …) }`. It splits ffmpeg's output into intervals at the forced IDRs.
  - `encodeIntervalAt(…, rateBps)` for an over-budget retry, which re-encodes one interval at `rate × 0.8` until it fits, with a floor of 1 Mbps.
- **Produces, in `segment-cache.ts`:** `class SegmentCache { constructor(dir: string, limitBytes: number); key(discId, level, audio, clip, clipSize, clipMtimeMs): string; get(key, index): Promise<Buffer | null>; put(key, index, bytes): Promise<void> }`. It is an LRU by total bytes, writes atomically, and evicts the oldest whole files.

- [ ] **Step 1: Failing tests** (CI uses `x264Backend`):
  - Encoding `disc-levels`'s clip from interval 3 emits intervals 3…9, each starting with an IDR whose PTS equals the EP entry's PTS (×2 for 90 kHz).
  - `disc-mpeg2` (interlaced) yields progressive frames at the frame rate.
  - The cache round trip works, eviction drops the oldest past the limit, and a changed clip size or mtime is a miss.
  - The over-budget retry: with a tiny forced budget, the retry lowers the rate until `remuxInterval` fits (Review Focus 1).
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expect PASS.
- [ ] **Step 5:** Commit `feat(server): live interval encoder with forced keyframes, and the segment cache`.

### Task 6: The level service: reads, read-ahead and capacity

**Files:**
- Create: `server/src/levels/level-service.ts`, `server/src/levels/capacity.ts`
- Test: `server/src/levels/level-service.test.ts`, `server/src/levels/capacity.test.ts`

**Interfaces:**
- **Consumes:** Tasks 2–5.
- **Produces, in `capacity.ts`:** `class Capacity { constructor(budgets: { h264: number; hevc: number }, now); lease(viewingId: string, codec, fps: number): boolean; touch(viewingId): void; release(viewingId): void; inUse(): {...} }`. A lease is admitted if `fps × 1.3` fits, kept by `touch`, and expires 2 min after the last touch.
- **Produces, in `level-service.ts`:**
  - `class LevelService { manifest(discId, level, audio): Promise<DiscManifest | { busy: true }>; read(discId, level, audio, path, offset, length, viewingId, signal): Promise<Buffer | { retryAfter: 1 }>; levels(discId, client: { hevc: boolean; hevc10: boolean; hdr: boolean }): Promise<LevelInfo[]> }`
  - `LevelInfo = { level: LevelId; label: string; budgetMbps: number; available: boolean; reason?: string }`.
  - **Reads:** a read maps an offset to its interval, serves it from the cache, waits on the running encoder if the interval is within 120 s of film ahead, and otherwise restarts the encoder at the interval (a seek). Bytes past the interval are served by continuing into the next.
  - **Timers:** after 15 s of waiting, a read gets `retryAfter`. An encoder stops 60 s after the last read.
  - **The viewing id** is the device id plus the disc, level and audio.

- [ ] **Step 1: Failing tests**, with a fake backend that emits intervals on a controllable clock:
  - sequential reads are served in order;
  - a seek to interval 8 while the encoder is at 2 restarts at 8, then a read of interval 1 hits the cache (Review Focus 2);
  - a read that waits more than 15 s gets `retryAfter`;
  - the encoder stops after 60 s idle;
  - the 4th 1080p H.264 viewing at 23.976 fps is still admitted (4 × 31 = 124 ≤ 190), the 7th is refused, and an HEVC viewing is counted against 100;
  - a lease expires 2 min after the last touch;
  - the manifest's `.m2ts` sizes equal `planClip`'s, and its inlined CLPI and MPLS are the rewritten ones.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expect PASS.
- [ ] **Step 5:** Commit `feat(server): level service: reads drive the encoder, leases within GPU capacity`.

### Task 7: Routes, the container and the GPU self-test

**Files:**
- Modify:
  - `server/src/routes/discs.ts` (`?level=&audio=` on manifest and files; `GET discs/<id>/levels?hevc=&hevc10=&hdr=`; 503 `Retry-After: 1` for `retryAfter`; 503 with the busy copy for a refused lease)
  - `server/src/routes/titles.ts` (`me.levels: boolean`)
  - `server/src/main.ts` (build the service; run a GPU self-test at start, a 1 s `testsrc` encode with `qsvBackend`, and fall back to `levels: false`)
  - `server/src/config.ts` (`LEVELS_BACKEND=qsv|x264|off`, `TRANSCODE_CACHE_BYTES`, `FFMPEG_PATH`)
  - `server/Dockerfile` (ffmpeg with iHD: jellyfin-ffmpeg's deb or Debian's ffmpeg plus `intel-media-va-driver-non-free`; pick the smaller that runs the spike's commands)
  - `server/deploy/compose.yaml` (`devices: ["/dev/dri/renderD128:/dev/dri/renderD128"]`, `group_add: ["993"]`)
  - `server/NOTICE`
  - CLAUDE.md (one line amending "no native dependencies": ffmpeg is a bundled binary)
- Test: `server/src/routes/discs.test.ts` (extend), `server/src/main.test.ts` or a config test for the fallback

**Interfaces:**
- **Consumes:** Task 6.
- **Produces:** the HTTP contract above; `level=original` or no level is today's behaviour, byte for byte.

- [ ] **Step 1: Failing tests** (`LEVELS_BACKEND=x264`):
  - the levels endpoint for `disc-mpeg2` lists no available `original` and lists `h264-1080`;
  - a manifest at a level returns rewritten CLPI;
  - a range read of a level's `.m2ts` returns 206 with the right length;
  - a read during encoding past 15 s gets 503 with `Retry-After: 1`, on a fake clock;
  - a refused lease returns 503 with the exact busy copy;
  - with `LEVELS_BACKEND=off`, `me.levels` is false and `?level=h264-1080` returns 404 (Review Focus 5);
  - the original-level responses are unchanged (an existing test still passes).
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run server/src`, `npm run typecheck` and `npm run server:build`, then `docker build` of `server/` for linux/amd64 and run its self-test with `LEVELS_BACKEND=x264` locally. Everything passes.
- [ ] **Step 5:** Commit `feat(server): quality-level routes, ffmpeg in the image, GPU self-test`.

### Task 8: The client transport

**Files:**
- Modify:
  - `src/engine/disc/http-transport.ts` (503 + `Retry-After`: wait that long and retry the same range, up to the existing request timeout per read; abort still works)
  - `src/engine/disc/disc-spec.ts` (`RemoteDiscSpec.query?: string`, appended to every files URL, carrying `level=…&audio=…`)
  - `src/engine/disc/rtc-wire.ts` callers only if needed (the WebRTC fetch already passes query and status)
- Test: `src/engine/disc/http-transport.test.ts`, `src/engine/disc/remote-source.test.ts`

**Interfaces:**
- **Produces:** `RemoteDiscSpec.query`. Phase 2's UI sets it, and nothing sets it yet.

- [ ] **Step 1: Failing tests.**
  - A 503 with `Retry-After: 1` is retried after 1 s (fake timer) and then succeeds.
  - Repeated 503s past the request timeout fail as today.
  - An abort during the wait rejects at once.
  - `query` is appended to every range URL and kept across token refreshes.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run src/engine/disc` and `npm test`. Everything passes.
- [ ] **Step 5:** Commit `feat(disc): request a quality level, retry while the NAS encodes`.

### Task 9: NAS verification, deploy and docs

**Files:**
- Create: `scripts/verify-level.ts`. It reads a disc's level over the API with a device token (taken from a fresh owner pairing it makes and removes itself), writes nothing to the NAS, and pipes the level's main clip into ffprobe/ffmpeg locally. It checks that every EP entry's PTS is an IDR, that decoding runs without errors, and that the file length matches the manifest. It prints throughput.
- Modify: CLAUDE.md (the levels architecture paragraph), the spec's status line, `docs/known-issues.md` (phase 2 pending; the levels are not reachable from the UI yet)

- [ ] **Step 1:** Run `npm test`, `npm run typecheck`, `npm run build` and `npm run server:build`. Everything passes.
- [ ] **Step 2 (controller, needs the user's approval):** merge to main, push, and `npm run server:deploy`.
- [ ] **Step 3 (controller):**
  - Run `npx tsx scripts/verify-level.ts` against the NAS on a 1080p H.264 disc at `h264-1080` and `phone-720`, on an MPEG-2 disc at `h264-1080`, and on a UHD disc at `h264-1080-sdr`.
  - Then run a 3-viewer load: three verify runs at once.
  - Record the throughput and over-budget counts in the spec's status line, referring to discs by codec only.
- [ ] **Step 4 (controller):** tell the BD-J session that the NAS side is live, and ask whether 5e's MPEG-2/VC-1 change has merged, which unblocks phase 2.
