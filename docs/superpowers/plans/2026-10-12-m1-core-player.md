# Milestone 1: Core Player Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Chromium web app that opens a decrypted BDMV folder, lists its playlists, and plays a chosen playlist with H.264/HEVC video (WebCodecs) and LPCM audio in sync. It supports seek, chapter skip, volume, and fullscreen.

**Architecture:** The React main thread collects the disc files and forwards them to a single engine worker. The worker parses BDMV navigation files, demuxes M2TS, and decodes video with `VideoDecoder` and LPCM in TypeScript. It renders to a transferred `OffscreenCanvas`. Audio flows through a `SharedArrayBuffer` ring to an `AudioWorklet`, whose read counter is the master clock. The engine (`src/engine/`) is framework-free TypeScript licensed LGPL-2.1.

**Tech Stack:** TypeScript (strict), React, Vite, Vitest, Playwright (Google Chrome channel), WebCodecs, AudioWorklet, File System Access API, IndexedDB, ffmpeg + libx264 (fixture generation only).

**Spec:** `docs/superpowers/specs/2026-10-12-bluray-web-player-design.md`. This plan implements **Milestone 1** (spec §11). Read the spec first.

## Global Constraints

- Client-side only; nothing is uploaded anywhere.
- v1 target: Chromium desktop (Chrome/Edge). Other browsers get a capability message, not a broken player.
- Input: a decrypted BDMV folder via the File System Access API, with a `<input webkitdirectory>` fallback. ISO is out of scope.
- `src/engine/` has no React imports and carries its own `LICENSE` (LGPL-2.1).
- The page must be cross-origin isolated: every dev/preview/static response sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.
- Time units: navigation uses 45 kHz ticks (as in libbluray); PES timestamps are 90 kHz; everything crossing a module boundary after demux is integer-ish microseconds (`…Us`).
- Paths inside the engine are disc-relative and upper-case: `BDMV/PLAYLIST/00000.MPLS`.
- Audio output is a 48 kHz stereo `AudioContext`. LPCM is downmixed to stereo and decimated from 96/192 kHz in the worker. (This is how M1 implements the spec's "resampled to the AudioContext rate".)
- M1 decodes LPCM audio only. Other audio codecs produce an `unsupported` event, and video plays on the wall clock (spec §8).
- A/V sync acceptance: mean presentation offset within ±20 ms at steady state, and back within tolerance within 1 s of a seek (spec §1).
- TypeScript style: explicit return types on exported functions, no `any`, no non-null assertions (`!`), `import type` for type-only imports, and no `enum` (use `as const` objects).
- Tests are colocated as `*.test.ts` next to their source. Shared test builders live in `tests/helpers/`.

## Review Focus

1. **Multi-play-item playlists** (most main features). Crossing an item boundary must not jump or stall the timeline, and seeking into item 2 must land in item 2. Covered by Task 7 (`locate` at boundaries), Task 15 (pipeline reads items in order), and Task 20 (E2E plays across the boundary).
2. **Discs whose only audio is AC-3/DTS/TrueHD.** That is most retail discs while M1 decodes LPCM only. Video must still play on the wall clock with an `unsupported` audio message, not freeze waiting for audio. Covered by a Task 16 test.
3. **Background tab or throttled rendering.** If `requestAnimationFrame` stops, audio keeps playing. The pipeline must not deadlock on a full video queue, and video must catch up when ticks resume. Covered by a Task 16 test.
4. **Folder selection variants.** The user may pick the disc root, the `BDMV` folder itself, a parent folder with one disc, a folder holding two discs, or a partial backup missing `STREAM` files. Each needs a correct result or a specific error. Covered by tests in Task 6.
5. **Rapid repeated seeks** (holding an arrow key). Only the last seek wins, and no frame from an earlier target is ever drawn. Covered by a Task 16 test.

## File Map

```
package.json, vite.config.ts, playwright.config.ts, tsconfig*.json, index.html, .gitignore
src/main.tsx
src/engine/LICENSE                          LGPL-2.1 text
src/engine/protocol.ts                      worker command/event types
src/engine/worker.ts                        worker entry; wires Player to postMessage
src/engine/player.ts                        orchestrates a playback session
src/engine/util/byte-reader.ts              big-endian byte/bit reader, ParseError
src/engine/util/time.ts                     45k/90k/µs conversions, PTS wrap math
src/engine/bdmv/stream-types.ts             coding-type constants and names
src/engine/bdmv/index-parser.ts             index.bdmv
src/engine/bdmv/mpls-parser.ts              .mpls playlists
src/engine/bdmv/clpi-parser.ts              .clpi clip info + EP map lookup
src/engine/disc/byte-source.ts              ByteSource interface, DiscError
src/engine/disc/paths.ts                    normalize picked files to disc paths
src/engine/disc/file-source.ts              ByteSource over Blob/File map
src/engine/disc/open-disc.ts                validate disc, summarize playlists, encryption check
src/engine/nav/timeline.ts                  playlist time ↔ clip PTS, chapters
src/engine/demux/ts-packet.ts               192-byte source packet parsing
src/engine/demux/pes-assembler.ts           TS → PES reassembly
src/engine/demux/m2ts-reader.ts             chunked, prefetching clip reader
src/engine/decode/nal.ts                    Annex-B split/join, RBSP unescape
src/engine/decode/h264.ts                   AVC access-unit analysis, codec string
src/engine/decode/hevc.ts                   HEVC access-unit analysis, codec string
src/engine/decode/decoder.ts                Decoder interface, errors
src/engine/decode/video-decoder.ts          WebCodecs VideoDecoder wrapper
src/engine/decode/lpcm.ts                   Blu-ray LPCM → stereo float
src/engine/decode/decimator.ts              96/192 kHz → 48 kHz
src/engine/audio/ring.ts                    SharedArrayBuffer ring, worklet render logic, RingWriter
src/engine/audio/audio-writer.ts            PTS → ring frame placement
src/engine/clock/master-clock.ts            audio-driven / wall clock
src/engine/render/video-presenter.ts        frame queue, pick/drop by clock
src/engine/render/compositor.ts             letterboxed drawing on OffscreenCanvas
src/engine/playback/stream-selection.ts     choose video/audio streams
src/engine/playback/pipeline.ts             read loop across play items with backpressure
src/player/pcm-worklet.ts                   AudioWorkletProcessor
src/player/audio-output.ts                  AudioContext + worklet + gain
src/player/player-controller.ts             worker bridge + external store
src/player/create-controller.ts             browser wiring
src/ui/App.tsx, LandingScreen.tsx, PlayerScreen.tsx, ControlBar.tsx, PlaylistPicker.tsx
src/ui/capabilities.ts, disc-input.ts, recent-discs.ts, keyboard.ts, format.ts, fs-access.d.ts, styles.css
tests/helpers/byte-writer.ts, bdmv-builders.ts, ts-muxer.ts, h264-units.ts, synthetic-disc.ts
tests/local/real-discs.test.ts              runs only if fixtures/local has discs
tests/e2e/smoke.spec.ts, playback.spec.ts, errors.spec.ts
scripts/make-fixture-disc.ts                generates fixtures/synthetic/disc1
fixtures/synthetic/disc1/…                  committed synthetic disc
fixtures/synthetic/not-a-disc/readme.txt
```

---

### Task 1: Project scaffold with cross-origin isolation

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json`, `vite.config.ts`, `playwright.config.ts`, `index.html`, `.gitignore`, `src/main.tsx`, `src/ui/App.tsx`, `src/ui/styles.css`, `src/engine/LICENSE`, `README.md`
- Test: `tests/e2e/smoke.spec.ts`

**Interfaces:**
- Produces: npm scripts `dev`, `build`, `preview`, `typecheck`, `test`, `test:e2e`, `fixture:synthetic`. Root element `data-testid="app"`. Every later App version must keep this test id.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "bluray-web",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "typecheck": "tsc -b",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "fixture:synthetic": "tsx scripts/make-fixture-disc.ts fixtures/synthetic/disc1"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run:
```bash
npm install react react-dom
npm install -D vite @vitejs/plugin-react typescript @types/react @types/react-dom @types/node vitest @playwright/test tsx fake-indexeddb
npx playwright install chrome
```
Expected: installs succeed. `playwright install chrome` installs Google Chrome stable. The Playwright-bundled Chromium cannot decode H.264, so the E2E tests use the `chrome` channel.

- [ ] **Step 3: Create TypeScript configs**

`tsconfig.json`:
```json
{
  "files": [],
  "references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.node.json" }]
}
```

`tsconfig.app.json`:
```json
{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.app.tsbuildinfo",
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2023", "DOM", "DOM.Iterable", "DOM.AsyncIterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "moduleDetection": "force",
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "types": ["vite/client"]
  },
  "include": ["src", "tests/helpers"]
}
```

`tsconfig.node.json`:
```json
{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.node.tsbuildinfo",
    "target": "ES2022",
    "lib": ["ES2023", "DOM", "DOM.Iterable", "DOM.AsyncIterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "moduleDetection": "force",
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "noEmit": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "types": ["node", "vite/client"]
  },
  "include": ["vite.config.ts", "playwright.config.ts", "scripts", "tests/e2e", "tests/local"]
}
```

- [ ] **Step 4: Create `vite.config.ts`**

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/** SharedArrayBuffer (the audio ring) requires cross-origin isolation. */
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react()],
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
  worker: { format: 'es' },
  test: {
    include: ['src/**/*.test.ts', 'tests/local/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
});
```

- [ ] **Step 5: Create `playwright.config.ts`**

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:4173',
    channel: 'chrome',
    launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
  },
  webServer: {
    command: 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
```

- [ ] **Step 6: Create the HTML entry, React entry, placeholder App, and CSS**

`index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Blu-ray Player</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`src/main.tsx`:
```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './ui/styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root element');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

`src/ui/App.tsx` (placeholder; Task 19 replaces it):
```tsx
import type { ReactElement } from 'react';

export function App(): ReactElement {
  return <main data-testid="app">Blu-ray Player</main>;
}
```

`src/ui/styles.css`:
```css
:root {
  color-scheme: dark;
  font-family: system-ui, sans-serif;
  background: #0b0b0d;
  color: #e8e8ea;
}
html, body, #root { height: 100%; margin: 0; }
```

- [ ] **Step 7: Add the LGPL license for the engine, `.gitignore`, and README**

Run:
```bash
mkdir -p src/engine
curl -fsSL https://www.gnu.org/licenses/old-licenses/lgpl-2.1.txt -o src/engine/LICENSE
head -3 src/engine/LICENSE
```
Expected: the output starts with `GNU LESSER GENERAL PUBLIC LICENSE` / `Version 2.1, February 1999`.

`.gitignore`:
```
node_modules
dist
fixtures/local
test-results
playwright-report
*.tsbuildinfo
```

`README.md`:
```markdown
# bluray-web

Client-side Blu-ray (BDMV) player for Chromium. Design: `docs/superpowers/specs/2026-10-12-bluray-web-player-design.md`.

- `src/engine/` is derived from libbluray and licensed LGPL-2.1 (see `src/engine/LICENSE`).
- `npm run dev`: dev server (cross-origin isolated).
- `npm test`: unit tests. `npm run test:e2e`: Playwright (requires Google Chrome).
- Put your own decrypted discs under `fixtures/local/<name>/BDMV/...` to enable `tests/local`.
```

- [ ] **Step 8: Write the failing smoke test**

`tests/e2e/smoke.spec.ts`:
```ts
import { expect, test } from '@playwright/test';

test('app is served cross-origin isolated', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('app')).toBeVisible();
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
});
```

- [ ] **Step 9: Run typecheck, unit tests, and the smoke test**

Run: `npm run typecheck && npm test && npm run test:e2e -- smoke`
Expected: typecheck passes; Vitest reports no tests (passes); Playwright reports `1 passed`. If `crossOriginIsolated` is false, the preview headers in `vite.config.ts` are wrong.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "chore: scaffold Vite React app with cross-origin isolation and test tooling"
```

---

### Task 2: Byte reader and test byte writer

**Files:**
- Create: `src/engine/util/byte-reader.ts`, `tests/helpers/byte-writer.ts`
- Test: `src/engine/util/byte-reader.test.ts`

**Interfaces:**
- Produces:
  - `class ParseError extends Error`
  - `class ByteReader(bytes: Uint8Array, start?: number)` with `position`, `length`, `remaining`, `seek(pos)`, `skip(n)`, `u8()`, `u16()`, `u32()`, `take(n): Uint8Array` (a subarray), `ascii(n): string`, `bits(n ≤ 32): number`, `flag(): boolean`, and `skipBits(n)`. Byte reads throw `ParseError` if they are not byte-aligned or past the end.
  - Test helper `class ByteWriter`: chainable `u8`, `u16`, `u32`, `ascii`, `bytes`, `zeros`, `bits(n, value)`; plus `position`, `patchU16(at, v)`, `patchU32(at, v)`, `toBytes(): Uint8Array<ArrayBuffer>`.

- [ ] **Step 1: Write the test writer** (test infrastructure; it is exercised by the reader tests below)

`tests/helpers/byte-writer.ts`:
```ts
/** Big-endian byte/bit writer used by tests and the fixture script to build binary files. */
export class ByteWriter {
  private buf = new Uint8Array(256);
  private len = 0;
  private bitAcc = 0;
  private bitCount = 0;

  get position(): number {
    this.requireAligned();
    return this.len;
  }

  u8(v: number): this {
    this.requireAligned();
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
    return this;
  }

  u16(v: number): this {
    return this.u8(v >>> 8).u8(v);
  }

  u32(v: number): this {
    return this.u16(Math.floor(v / 0x10000) & 0xffff).u16(v & 0xffff);
  }

  ascii(s: string): this {
    for (const ch of s) this.u8(ch.charCodeAt(0));
    return this;
  }

  bytes(b: Uint8Array): this {
    this.requireAligned();
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
    return this;
  }

  zeros(n: number): this {
    return this.bytes(new Uint8Array(n));
  }

  /** Writes the low `n` bits of `v`, most significant first. */
  bits(n: number, v: number): this {
    for (let i = n - 1; i >= 0; i--) {
      const bit = Math.floor(v / 2 ** i) % 2;
      this.bitAcc = (this.bitAcc << 1) | bit;
      if (++this.bitCount === 8) {
        this.ensure(1);
        this.buf[this.len++] = this.bitAcc;
        this.bitAcc = 0;
        this.bitCount = 0;
      }
    }
    return this;
  }

  patchU16(at: number, v: number): this {
    this.buf[at] = (v >>> 8) & 0xff;
    this.buf[at + 1] = v & 0xff;
    return this;
  }

  patchU32(at: number, v: number): this {
    this.patchU16(at, Math.floor(v / 0x10000) & 0xffff);
    return this.patchU16(at + 2, v & 0xffff);
  }

  toBytes(): Uint8Array<ArrayBuffer> {
    this.requireAligned();
    return this.buf.slice(0, this.len);
  }

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  private requireAligned(): void {
    if (this.bitCount !== 0) throw new Error(`ByteWriter: ${this.bitCount} pending bits`);
  }
}
```

- [ ] **Step 2: Write the failing reader tests**

`src/engine/util/byte-reader.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ByteWriter } from '../../../tests/helpers/byte-writer';
import { ByteReader, ParseError } from './byte-reader';

describe('ByteReader', () => {
  it('reads big-endian integers including values above 2^31', () => {
    const bytes = new ByteWriter().u8(0xab).u16(0x1234).u32(0xfedcba98).toBytes();
    const r = new ByteReader(bytes);
    expect(r.u8()).toBe(0xab);
    expect(r.u16()).toBe(0x1234);
    expect(r.u32()).toBe(0xfedcba98);
    expect(r.remaining).toBe(0);
  });

  it('reads bit fields MSB first across byte boundaries', () => {
    const bytes = new ByteWriter().bits(2, 1).bits(14, 0x2abc).bits(18, 0x3ffff).bits(14, 0x1555).toBytes();
    const r = new ByteReader(bytes);
    expect(r.bits(2)).toBe(1);
    expect(r.bits(14)).toBe(0x2abc);
    expect(r.bits(18)).toBe(0x3ffff);
    expect(r.bits(14)).toBe(0x1555);
  });

  it('reads 32-bit bit fields without sign overflow', () => {
    const r = new ByteReader(new ByteWriter().bits(32, 0xffffffff).toBytes());
    expect(r.bits(32)).toBe(0xffffffff);
  });

  it('reads ascii strings and subarrays, and seeks', () => {
    const bytes = new ByteWriter().ascii('MPLS').u8(7).u8(9).toBytes();
    const r = new ByteReader(bytes);
    expect(r.ascii(4)).toBe('MPLS');
    expect(Array.from(r.take(2))).toEqual([7, 9]);
    r.seek(1);
    expect(r.ascii(2)).toBe('PL');
  });

  it('throws ParseError when reading past the end', () => {
    const r = new ByteReader(new Uint8Array([1]));
    r.u8();
    expect(() => r.u8()).toThrow(ParseError);
    expect(() => new ByteReader(new Uint8Array(2)).u32()).toThrow(ParseError);
  });

  it('throws ParseError on unaligned byte reads', () => {
    const r = new ByteReader(new Uint8Array([0xff, 0xff]));
    r.bits(3);
    expect(() => r.u8()).toThrow(ParseError);
  });

  it('skipBits handles more than 32 bits', () => {
    const r = new ByteReader(new ByteWriter().zeros(5).u8(0x42).toBytes());
    r.skipBits(40);
    expect(r.u8()).toBe(0x42);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/engine/util/byte-reader.test.ts`
Expected: FAIL, because `./byte-reader` cannot be resolved.

- [ ] **Step 4: Implement `src/engine/util/byte-reader.ts`**

```ts
export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

/** Big-endian reader with MSB-first bit access, modelled on libbluray's BITSTREAM. */
export class ByteReader {
  private pos: number;
  private bitPos = 0;

  constructor(
    private readonly bytes: Uint8Array,
    start = 0,
  ) {
    this.pos = start;
  }

  get position(): number {
    return this.pos;
  }

  get length(): number {
    return this.bytes.length;
  }

  get remaining(): number {
    return this.bytes.length - this.pos;
  }

  seek(pos: number): void {
    if (pos < 0 || pos > this.bytes.length) {
      throw new ParseError(`seek to ${pos} outside 0..${this.bytes.length}`);
    }
    this.pos = pos;
    this.bitPos = 0;
  }

  skip(n: number): void {
    this.requireAligned();
    this.seek(this.pos + n);
  }

  u8(): number {
    this.requireAligned();
    this.require(1);
    return this.bytes[this.pos++];
  }

  u16(): number {
    const hi = this.u8();
    return (hi << 8) | this.u8();
  }

  u32(): number {
    const hi = this.u16();
    return hi * 0x10000 + this.u16();
  }

  take(n: number): Uint8Array {
    this.requireAligned();
    this.require(n);
    const view = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return view;
  }

  ascii(n: number): string {
    return String.fromCharCode(...this.take(n));
  }

  bits(n: number): number {
    if (n < 1 || n > 32) throw new ParseError(`bits(${n}) out of range`);
    let value = 0;
    for (let i = 0; i < n; i++) {
      if (this.pos >= this.bytes.length) throw new ParseError('bit read past end');
      const bit = (this.bytes[this.pos] >> (7 - this.bitPos)) & 1;
      value = value * 2 + bit;
      if (++this.bitPos === 8) {
        this.bitPos = 0;
        this.pos++;
      }
    }
    return value;
  }

  flag(): boolean {
    return this.bits(1) === 1;
  }

  skipBits(n: number): void {
    let left = n;
    while (left > 0) {
      const k = Math.min(left, 32);
      this.bits(k);
      left -= k;
    }
  }

  private require(n: number): void {
    if (this.pos + n > this.bytes.length) {
      throw new ParseError(`need ${n} bytes at ${this.pos}, have ${this.remaining}`);
    }
  }

  private requireAligned(): void {
    if (this.bitPos !== 0) throw new ParseError(`unaligned byte read at ${this.pos}.${this.bitPos}`);
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/engine/util/byte-reader.test.ts && npm run typecheck`
Expected: 7 passed; typecheck passes.

- [ ] **Step 6: Commit**

```bash
git add src/engine/util tests/helpers/byte-writer.ts
git commit -m "feat(engine): add big-endian byte/bit reader and test writer"
```

---

### Task 3: Stream-type constants and the index.bdmv parser

**Files:**
- Create: `src/engine/bdmv/stream-types.ts`, `src/engine/bdmv/index-parser.ts`, `tests/helpers/bdmv-builders.ts`
- Test: `src/engine/bdmv/index-parser.test.ts`

**Interfaces:**
- Consumes: `ByteReader`, `ParseError` (Task 2); `ByteWriter` (Task 2).
- Produces:
  - `CodingType` constants; `isVideoCoding(t)`, `isAudioCoding(t)`, `codingName(t): string`.
  - `type IndexObject = {kind:'hdmv', playbackType, movieObjectId} | {kind:'bdj', playbackType, name} | {kind:'unknown', objectType}`
  - `interface IndexTitle { object: IndexObject; accessType: number }`
  - `interface IndexBdmv { version; firstPlay; topMenu; titles }`
  - `parseIndex(bytes): IndexBdmv`; `indexUsesBdj(index): boolean`
  - Test builder: `buildIndex(spec: IndexSpec): Uint8Array<ArrayBuffer>`, with `IndexObjectSpec = {kind:'hdmv', movieObjectId, playbackType?} | {kind:'bdj', name, playbackType?}`.

- [ ] **Step 1: Create `src/engine/bdmv/stream-types.ts`**

```ts
/** Stream coding types used in MPLS STN tables and CLPI program info (libbluray bdnav/mpls_data.h). */
export const CodingType = {
  MPEG1_VIDEO: 0x01,
  MPEG2_VIDEO: 0x02,
  MPEG1_AUDIO: 0x03,
  MPEG2_AUDIO: 0x04,
  AVC: 0x1b,
  MVC: 0x20,
  HEVC: 0x24,
  VC1: 0xea,
  LPCM: 0x80,
  AC3: 0x81,
  DTS: 0x82,
  TRUEHD: 0x83,
  EAC3: 0x84,
  DTSHD: 0x85,
  DTSHD_MASTER: 0x86,
  EAC3_SECONDARY: 0xa1,
  DTSHD_SECONDARY: 0xa2,
  PG: 0x90,
  IG: 0x91,
  TEXT_SUBTITLE: 0x92,
} as const;

const VIDEO_TYPES = new Set<number>([0x01, 0x02, 0x1b, 0x20, 0x24, 0xea]);
const AUDIO_TYPES = new Set<number>([0x03, 0x04, 0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0xa1, 0xa2]);

const NAMES: Readonly<Record<number, string>> = {
  0x01: 'MPEG-1 video',
  0x02: 'MPEG-2 video',
  0x03: 'MPEG-1 audio',
  0x04: 'MPEG-2 audio',
  0x1b: 'H.264/AVC',
  0x20: 'H.264/MVC',
  0x24: 'H.265/HEVC',
  0xea: 'VC-1',
  0x80: 'LPCM',
  0x81: 'Dolby Digital (AC-3)',
  0x82: 'DTS',
  0x83: 'Dolby TrueHD',
  0x84: 'Dolby Digital Plus (E-AC-3)',
  0x85: 'DTS-HD High Resolution',
  0x86: 'DTS-HD Master Audio',
  0xa1: 'Dolby Digital Plus (secondary)',
  0xa2: 'DTS-HD (secondary)',
  0x90: 'PG subtitles',
  0x91: 'Interactive graphics',
  0x92: 'Text subtitles',
};

export function isVideoCoding(codingType: number): boolean {
  return VIDEO_TYPES.has(codingType);
}

export function isAudioCoding(codingType: number): boolean {
  return AUDIO_TYPES.has(codingType);
}

export function codingName(codingType: number): string {
  return NAMES[codingType] ?? `unknown codec 0x${codingType.toString(16)}`;
}
```

- [ ] **Step 2: Create the builder file with `buildIndex`**

`tests/helpers/bdmv-builders.ts`:
```ts
import { CodingType, isAudioCoding, isVideoCoding } from '../../src/engine/bdmv/stream-types';
import { ByteWriter } from './byte-writer';

export type IndexObjectSpec =
  | { kind: 'hdmv'; movieObjectId: number; playbackType?: number }
  | { kind: 'bdj'; name: string; playbackType?: number };

export interface IndexSpec {
  firstPlay: IndexObjectSpec;
  topMenu: IndexObjectSpec;
  titles: IndexObjectSpec[];
}

export function buildIndex(spec: IndexSpec): Uint8Array<ArrayBuffer> {
  const w = new ByteWriter();
  w.ascii('INDX').ascii('0200');
  const indexesStartAt = w.position;
  w.u32(0); // indexes_start_address (patched)
  w.u32(0); // extension_data_start_address
  w.zeros(24);
  w.u32(34).zeros(34); // AppInfoBDMV
  w.patchU32(indexesStartAt, w.position);
  const lengthAt = w.position;
  w.u32(0);
  writeIndexObject(w, spec.firstPlay, false);
  writeIndexObject(w, spec.topMenu, false);
  w.u16(spec.titles.length);
  for (const title of spec.titles) writeIndexObject(w, title, true);
  w.patchU32(lengthAt, w.position - lengthAt - 4);
  return w.toBytes();
}

function writeIndexObject(w: ByteWriter, o: IndexObjectSpec, isTitle: boolean): void {
  w.bits(2, o.kind === 'hdmv' ? 1 : 2);
  if (isTitle) w.bits(2, 0).bits(28, 0);
  else w.bits(30, 0);
  w.bits(2, o.playbackType ?? 0).bits(14, 0);
  if (o.kind === 'hdmv') w.u16(o.movieObjectId).u32(0);
  else w.ascii(o.name.padEnd(5, '0').slice(0, 5)).u8(0);
}

// Silence unused-import errors until later tasks add MPLS/CLPI builders that use these.
void CodingType;
void isAudioCoding;
void isVideoCoding;
```

- [ ] **Step 3: Write the failing tests**

`src/engine/bdmv/index-parser.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildIndex } from '../../../tests/helpers/bdmv-builders';
import { ParseError } from '../util/byte-reader';
import { indexUsesBdj, parseIndex } from './index-parser';

describe('parseIndex', () => {
  it('parses HDMV first play, top menu and titles', () => {
    const index = parseIndex(
      buildIndex({
        firstPlay: { kind: 'hdmv', movieObjectId: 0 },
        topMenu: { kind: 'hdmv', movieObjectId: 1 },
        titles: [
          { kind: 'hdmv', movieObjectId: 2 },
          { kind: 'hdmv', movieObjectId: 3, playbackType: 1 },
        ],
      }),
    );
    expect(index.version).toBe('0200');
    expect(index.firstPlay).toEqual({ kind: 'hdmv', playbackType: 0, movieObjectId: 0 });
    expect(index.topMenu).toEqual({ kind: 'hdmv', playbackType: 0, movieObjectId: 1 });
    expect(index.titles.map((t) => t.object)).toEqual([
      { kind: 'hdmv', playbackType: 0, movieObjectId: 2 },
      { kind: 'hdmv', playbackType: 1, movieObjectId: 3 },
    ]);
    expect(indexUsesBdj(index)).toBe(false);
  });

  it('detects BD-J objects', () => {
    const index = parseIndex(
      buildIndex({
        firstPlay: { kind: 'bdj', name: '00000' },
        topMenu: { kind: 'hdmv', movieObjectId: 0 },
        titles: [{ kind: 'bdj', name: '00001' }],
      }),
    );
    expect(index.firstPlay).toEqual({ kind: 'bdj', playbackType: 0, name: '00000' });
    expect(indexUsesBdj(index)).toBe(true);
  });

  it('rejects a bad signature', () => {
    const bytes = buildIndex({ firstPlay: { kind: 'hdmv', movieObjectId: 0 }, topMenu: { kind: 'hdmv', movieObjectId: 0 }, titles: [] });
    bytes[0] = 0x58;
    expect(() => parseIndex(bytes)).toThrow(ParseError);
  });

  it('rejects a truncated file', () => {
    const bytes = buildIndex({ firstPlay: { kind: 'hdmv', movieObjectId: 0 }, topMenu: { kind: 'hdmv', movieObjectId: 0 }, titles: [{ kind: 'hdmv', movieObjectId: 1 }] });
    expect(() => parseIndex(bytes.subarray(0, bytes.length - 4))).toThrow(ParseError);
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run src/engine/bdmv/index-parser.test.ts`
Expected: FAIL, because `./index-parser` cannot be resolved.

- [ ] **Step 5: Implement `src/engine/bdmv/index-parser.ts`**

```ts
import { ByteReader, ParseError } from '../util/byte-reader';

/** Ported from libbluray bdnav/index_parse.c. */
export type IndexObject =
  | { readonly kind: 'hdmv'; readonly playbackType: number; readonly movieObjectId: number }
  | { readonly kind: 'bdj'; readonly playbackType: number; readonly name: string }
  | { readonly kind: 'unknown'; readonly objectType: number };

export interface IndexTitle {
  readonly object: IndexObject;
  readonly accessType: number;
}

export interface IndexBdmv {
  readonly version: string;
  readonly firstPlay: IndexObject;
  readonly topMenu: IndexObject;
  readonly titles: readonly IndexTitle[];
}

const OBJECT_TYPE_HDMV = 1;
const OBJECT_TYPE_BDJ = 2;

export function parseIndex(bytes: Uint8Array): IndexBdmv {
  const r = new ByteReader(bytes);
  const signature = r.ascii(4);
  const version = r.ascii(4);
  if (signature !== 'INDX') throw new ParseError(`index.bdmv: bad signature "${signature}"`);
  const indexesStart = r.u32();
  r.seek(indexesStart);
  const length = r.u32();
  if (length > r.remaining) throw new ParseError('index.bdmv: truncated indexes section');

  const firstPlayType = r.bits(2);
  r.skipBits(30);
  const firstPlay = readObject(r, firstPlayType);
  const topMenuType = r.bits(2);
  r.skipBits(30);
  const topMenu = readObject(r, topMenuType);

  const count = r.u16();
  const titles: IndexTitle[] = [];
  for (let i = 0; i < count; i++) {
    const objectType = r.bits(2);
    const accessType = r.bits(2);
    r.skipBits(28);
    titles.push({ object: readObject(r, objectType), accessType });
  }
  return { version, firstPlay, topMenu, titles };
}

function readObject(r: ByteReader, objectType: number): IndexObject {
  const playbackType = r.bits(2);
  r.skipBits(14);
  if (objectType === OBJECT_TYPE_HDMV) {
    const movieObjectId = r.u16();
    r.skip(4);
    return { kind: 'hdmv', playbackType, movieObjectId };
  }
  if (objectType === OBJECT_TYPE_BDJ) {
    const name = r.ascii(5);
    r.skip(1);
    return { kind: 'bdj', playbackType, name };
  }
  r.skip(6);
  return { kind: 'unknown', objectType };
}

export function indexUsesBdj(index: IndexBdmv): boolean {
  return [index.firstPlay, index.topMenu, ...index.titles.map((t) => t.object)].some((o) => o.kind === 'bdj');
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/engine/bdmv && npm run typecheck`
Expected: 4 passed; typecheck passes.

- [ ] **Step 7: Commit**

```bash
git add src/engine/bdmv tests/helpers/bdmv-builders.ts
git commit -m "feat(engine): parse index.bdmv and define stream coding types"
```

---

### Task 4: MPLS playlist parser

**Files:**
- Create: `src/engine/bdmv/mpls-parser.ts`
- Modify: `tests/helpers/bdmv-builders.ts` (add `buildMpls` and `writeCodingInfo`; remove the three `void` lines)
- Test: `src/engine/bdmv/mpls-parser.test.ts`

**Interfaces:**
- Consumes: `ByteReader`, `ParseError`, `CodingType`, `isVideoCoding`, `isAudioCoding`.
- Produces:
  - `interface StreamEntry { pid; codingType; format; rate; lang; subPath: boolean }`
  - `interface StnTable { video; audio; pg; ig: readonly StreamEntry[] }`
  - `interface PlayItem { clipId; codecId; connectionCondition; stcId; inTime; outTime /* 45 kHz */; uoMask: Uint8Array; stillMode; stillTime; isMultiAngle; angleClipIds: string[]; stn: StnTable }`
  - `interface PlayListMark { type; playItemRef; time /* 45 kHz clip time */; entryEsPid; duration }`
  - `interface Mpls { version; playbackType; uoMask; playItems; marks }`
  - `const MarkType = { ENTRY: 1, LINK: 2 }`
  - `parseMpls(bytes): Mpls`
  - Builder: `buildMpls(spec: MplsSpec)`, where `StreamSpec { pid; codingType; format?; rate?; lang?; streamType?; extraAttrBytes? }`, `PlayItemSpec { clipId; inTime; outTime; connectionCondition?; video?; audio?; pg?; ig?; angleClipIds? }`, `MarkSpec { playItemRef; time; type? }`, `MplsSpec { playItems: PlayItemSpec[]; marks?: MarkSpec[] }`; and `writeCodingInfo(w, codingType, lang?, extraBytes?)`.

- [ ] **Step 1: Add the MPLS builder** to `tests/helpers/bdmv-builders.ts`. Delete the three `void …;` lines at the bottom, then append:

```ts
export interface StreamSpec {
  pid: number;
  codingType: number;
  format?: number;
  rate?: number;
  lang?: string;
  /** 1 = main clip (default), 2/3/4 = sub-path streams. */
  streamType?: number;
  /** Extra zero bytes after the attributes, to test length-based skipping. */
  extraAttrBytes?: number;
}

export interface PlayItemSpec {
  clipId: string;
  inTime: number;
  outTime: number;
  connectionCondition?: number;
  video?: StreamSpec[];
  audio?: StreamSpec[];
  pg?: StreamSpec[];
  ig?: StreamSpec[];
  angleClipIds?: string[];
}

export interface MarkSpec {
  playItemRef: number;
  time: number;
  type?: number;
}

export interface MplsSpec {
  playItems: PlayItemSpec[];
  marks?: MarkSpec[];
}

/** Writes a length byte plus a 5-byte (or longer) stream attribute block, shared by MPLS and CLPI. */
export function writeCodingInfo(
  w: ByteWriter,
  codingType: number,
  opts: { format?: number; rate?: number; lang?: string; extraBytes?: number } = {},
): void {
  const extra = opts.extraBytes ?? 0;
  w.u8(5 + extra).u8(codingType);
  if (isVideoCoding(codingType)) {
    w.bits(4, opts.format ?? 6).bits(4, opts.rate ?? 1).zeros(3);
  } else if (isAudioCoding(codingType)) {
    w.bits(4, opts.format ?? 3).bits(4, opts.rate ?? 1).ascii(opts.lang ?? 'eng');
  } else if (codingType === CodingType.TEXT_SUBTITLE) {
    w.u8(1).ascii(opts.lang ?? 'eng');
  } else {
    w.ascii(opts.lang ?? 'eng').u8(0);
  }
  w.zeros(extra);
}

function writeStream(w: ByteWriter, s: StreamSpec): void {
  const streamType = s.streamType ?? 1;
  w.u8(9).u8(streamType);
  if (streamType === 1) w.u16(s.pid).zeros(6);
  else if (streamType === 2) w.u8(0).u8(0).u16(s.pid).zeros(4);
  else w.u8(0).u16(s.pid).zeros(5);
  writeCodingInfo(w, s.codingType, { format: s.format, rate: s.rate, lang: s.lang, extraBytes: s.extraAttrBytes });
}

function writePlayItem(w: ByteWriter, item: PlayItemSpec): void {
  const start = w.position;
  w.u16(0);
  const angles = item.angleClipIds ?? [];
  w.ascii(item.clipId).ascii('M2TS');
  w.bits(11, 0).bits(1, angles.length > 0 ? 1 : 0).bits(4, item.connectionCondition ?? 1);
  w.u8(0).u32(item.inTime).u32(item.outTime);
  w.zeros(8); // UO mask
  w.u8(0); // random_access_flag + reserved
  w.u8(0).u16(0); // still mode, still time
  if (angles.length > 0) {
    w.u8(angles.length + 1).u8(0);
    for (const clip of angles) w.ascii(clip).ascii('M2TS').u8(0);
  }
  const stnStart = w.position;
  w.u16(0).u16(0);
  const video = item.video ?? [];
  const audio = item.audio ?? [];
  const pg = item.pg ?? [];
  const ig = item.ig ?? [];
  w.u8(video.length).u8(audio.length).u8(pg.length).u8(ig.length);
  w.u8(0).u8(0).u8(0).zeros(5);
  for (const s of [...video, ...audio, ...pg, ...ig]) writeStream(w, s);
  w.patchU16(stnStart, w.position - stnStart - 2);
  w.patchU16(start, w.position - start - 2);
}

export function buildMpls(spec: MplsSpec): Uint8Array<ArrayBuffer> {
  const w = new ByteWriter();
  w.ascii('MPLS').ascii('0200');
  const listPosAt = w.position;
  w.u32(0).u32(0).u32(0); // list, mark, extension positions
  w.zeros(20);
  w.u32(14).u8(0).u8(1).u16(0).zeros(8).u16(0); // AppInfoPlayList
  w.patchU32(listPosAt, w.position);
  const listStart = w.position;
  w.u32(0).u16(0).u16(spec.playItems.length).u16(0);
  for (const item of spec.playItems) writePlayItem(w, item);
  w.patchU32(listStart, w.position - listStart - 4);
  const marks = spec.marks ?? [];
  w.patchU32(listPosAt + 4, w.position);
  w.u32(2 + 14 * marks.length).u16(marks.length);
  for (const m of marks) w.u8(0).u8(m.type ?? 1).u16(m.playItemRef).u32(m.time).u16(0xffff).u32(0);
  return w.toBytes();
}
```

- [ ] **Step 2: Write the failing tests**

`src/engine/bdmv/mpls-parser.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildMpls } from '../../../tests/helpers/bdmv-builders';
import { ParseError } from '../util/byte-reader';
import { MarkType, parseMpls } from './mpls-parser';
import { CodingType } from './stream-types';

const VIDEO = { pid: 0x1011, codingType: CodingType.AVC, format: 6, rate: 1 };

describe('parseMpls', () => {
  it('parses play items, STN streams and marks', () => {
    const mpls = parseMpls(
      buildMpls({
        playItems: [
          {
            clipId: '00001',
            inTime: 900_000,
            outTime: 1_800_000,
            video: [VIDEO],
            audio: [
              { pid: 0x1100, codingType: CodingType.LPCM, lang: 'eng' },
              { pid: 0x1101, codingType: CodingType.AC3, lang: 'fra' },
            ],
            pg: [{ pid: 0x1200, codingType: CodingType.PG, lang: 'deu' }],
            ig: [{ pid: 0x1400, codingType: CodingType.IG, lang: 'eng' }],
          },
          { clipId: '00002', inTime: 450_000, outTime: 900_000, connectionCondition: 5, video: [VIDEO] },
        ],
        marks: [
          { playItemRef: 0, time: 900_000 },
          { playItemRef: 1, time: 450_000 },
          { playItemRef: 1, time: 500_000, type: MarkType.LINK },
        ],
      }),
    );
    expect(mpls.version).toBe('0200');
    expect(mpls.playItems).toHaveLength(2);
    const [first, second] = mpls.playItems;
    expect(first.clipId).toBe('00001');
    expect(first.codecId).toBe('M2TS');
    expect(first.inTime).toBe(900_000);
    expect(first.outTime).toBe(1_800_000);
    expect(first.stn.video).toEqual([{ pid: 0x1011, codingType: CodingType.AVC, format: 6, rate: 1, lang: '', subPath: false }]);
    expect(first.stn.audio.map((a) => [a.pid, a.codingType, a.lang])).toEqual([
      [0x1100, CodingType.LPCM, 'eng'],
      [0x1101, CodingType.AC3, 'fra'],
    ]);
    expect(first.stn.pg[0].lang).toBe('deu');
    expect(first.stn.ig[0].pid).toBe(0x1400);
    expect(second.connectionCondition).toBe(5);
    expect(second.stn.audio).toEqual([]);
    expect(mpls.marks).toEqual([
      { type: MarkType.ENTRY, playItemRef: 0, time: 900_000, entryEsPid: 0xffff, duration: 0 },
      { type: MarkType.ENTRY, playItemRef: 1, time: 450_000, entryEsPid: 0xffff, duration: 0 },
      { type: MarkType.LINK, playItemRef: 1, time: 500_000, entryEsPid: 0xffff, duration: 0 },
    ]);
  });

  it('skips attribute blocks by their length and flags sub-path streams', () => {
    const mpls = parseMpls(
      buildMpls({
        playItems: [
          {
            clipId: '00001',
            inTime: 0,
            outTime: 100,
            video: [{ pid: 0x1011, codingType: CodingType.HEVC, extraAttrBytes: 4 }],
            audio: [
              { pid: 0x1100, codingType: CodingType.LPCM, streamType: 2 },
              { pid: 0x1101, codingType: CodingType.LPCM },
            ],
          },
        ],
      }),
    );
    const item = mpls.playItems[0];
    expect(item.stn.video[0].codingType).toBe(CodingType.HEVC);
    expect(item.stn.audio.map((a) => [a.pid, a.subPath])).toEqual([
      [0x1100, true],
      [0x1101, false],
    ]);
  });

  it('parses multi-angle play items', () => {
    const mpls = parseMpls(
      buildMpls({ playItems: [{ clipId: '00001', inTime: 0, outTime: 100, angleClipIds: ['00002', '00003'], video: [VIDEO] }] }),
    );
    expect(mpls.playItems[0].isMultiAngle).toBe(true);
    expect(mpls.playItems[0].angleClipIds).toEqual(['00002', '00003']);
    expect(mpls.playItems[0].stn.video).toHaveLength(1);
  });

  it('rejects a bad signature', () => {
    const bytes = buildMpls({ playItems: [] });
    bytes[1] = 0x41;
    expect(() => parseMpls(bytes)).toThrow(ParseError);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/engine/bdmv/mpls-parser.test.ts`
Expected: FAIL, because `./mpls-parser` cannot be resolved.

- [ ] **Step 4: Implement `src/engine/bdmv/mpls-parser.ts`**

```ts
import { ByteReader, ParseError } from '../util/byte-reader';
import { CodingType, isAudioCoding, isVideoCoding } from './stream-types';

/** Ported from libbluray bdnav/mpls_parse.c (playlist, play items, STN, marks). */
export interface StreamEntry {
  readonly pid: number;
  readonly codingType: number;
  readonly format: number;
  readonly rate: number;
  readonly lang: string;
  /** True for streams carried in a sub-path clip (stream_type 2–4); M1 plays main-path streams only. */
  readonly subPath: boolean;
}

export interface StnTable {
  readonly video: readonly StreamEntry[];
  readonly audio: readonly StreamEntry[];
  readonly pg: readonly StreamEntry[];
  readonly ig: readonly StreamEntry[];
}

export interface PlayItem {
  readonly clipId: string;
  readonly codecId: string;
  readonly connectionCondition: number;
  readonly stcId: number;
  /** 45 kHz clip time. */
  readonly inTime: number;
  /** 45 kHz clip time (exclusive). */
  readonly outTime: number;
  readonly uoMask: Uint8Array;
  readonly stillMode: number;
  readonly stillTime: number;
  readonly isMultiAngle: boolean;
  readonly angleClipIds: readonly string[];
  readonly stn: StnTable;
}

export interface PlayListMark {
  readonly type: number;
  readonly playItemRef: number;
  /** 45 kHz clip time within the referenced play item. */
  readonly time: number;
  readonly entryEsPid: number;
  readonly duration: number;
}

export interface Mpls {
  readonly version: string;
  readonly playbackType: number;
  readonly uoMask: Uint8Array;
  readonly playItems: readonly PlayItem[];
  readonly marks: readonly PlayListMark[];
}

export const MarkType = { ENTRY: 1, LINK: 2 } as const;

export function parseMpls(bytes: Uint8Array): Mpls {
  const r = new ByteReader(bytes);
  const signature = r.ascii(4);
  const version = r.ascii(4);
  if (signature !== 'MPLS') throw new ParseError(`mpls: bad signature "${signature}"`);
  const listPos = r.u32();
  const markPos = r.u32();
  r.u32(); // extension data position

  r.seek(40);
  const appInfoLength = r.u32();
  const appInfoStart = r.position;
  r.skip(1);
  const playbackType = r.u8();
  r.skip(2);
  const uoMask = r.take(8).slice();
  r.seek(appInfoStart + appInfoLength);

  r.seek(listPos);
  r.u32(); // length
  r.skip(2);
  const itemCount = r.u16();
  r.u16(); // sub-path count
  const playItems: PlayItem[] = [];
  for (let i = 0; i < itemCount; i++) playItems.push(readPlayItem(r));

  return { version, playbackType, uoMask, playItems, marks: readMarks(r, markPos) };
}

function readPlayItem(r: ByteReader): PlayItem {
  const length = r.u16();
  const start = r.position;
  const clipId = r.ascii(5);
  const codecId = r.ascii(4);
  r.skipBits(11);
  const isMultiAngle = r.flag();
  const connectionCondition = r.bits(4);
  const stcId = r.u8();
  const inTime = r.u32();
  const outTime = r.u32();
  const uoMask = r.take(8).slice();
  r.skip(1); // random_access_flag + reserved
  const stillMode = r.u8();
  const stillTimeField = r.u16();
  const angleClipIds: string[] = [];
  if (isMultiAngle) {
    const angleCount = r.u8();
    r.skip(1);
    for (let a = 1; a < angleCount; a++) {
      angleClipIds.push(r.ascii(5));
      r.skip(4 + 1); // codec id, stc id
    }
  }
  const stn = readStn(r);
  r.seek(start + length);
  return {
    clipId,
    codecId,
    connectionCondition,
    stcId,
    inTime,
    outTime,
    uoMask,
    stillMode,
    stillTime: stillMode === 1 ? stillTimeField : 0,
    isMultiAngle,
    angleClipIds,
    stn,
  };
}

function readStn(r: ByteReader): StnTable {
  const length = r.u16();
  const start = r.position;
  r.skip(2);
  const videoCount = r.u8();
  const audioCount = r.u8();
  const pgCount = r.u8();
  const igCount = r.u8();
  r.skip(3 + 5); // secondary audio/video and PiP PG counts, reserved
  const readMany = (n: number): StreamEntry[] => Array.from({ length: n }, () => readStream(r));
  const video = readMany(videoCount);
  const audio = readMany(audioCount);
  const pg = readMany(pgCount);
  const ig = readMany(igCount);
  r.seek(start + length);
  return { video, audio, pg, ig };
}

function readStream(r: ByteReader): StreamEntry {
  const entryLength = r.u8();
  const entryStart = r.position;
  const streamType = r.u8();
  let pid = 0;
  switch (streamType) {
    case 1:
      pid = r.u16();
      break;
    case 2:
      r.skip(2);
      pid = r.u16();
      break;
    case 3:
    case 4:
      r.skip(1);
      pid = r.u16();
      break;
    default:
      break;
  }
  r.seek(entryStart + entryLength);

  const attrLength = r.u8();
  const attrStart = r.position;
  const codingType = r.u8();
  let format = 0;
  let rate = 0;
  let lang = '';
  if (isVideoCoding(codingType)) {
    format = r.bits(4);
    rate = r.bits(4);
  } else if (isAudioCoding(codingType)) {
    format = r.bits(4);
    rate = r.bits(4);
    lang = r.ascii(3);
  } else if (codingType === CodingType.PG || codingType === CodingType.IG) {
    lang = r.ascii(3);
  } else if (codingType === CodingType.TEXT_SUBTITLE) {
    r.skip(1);
    lang = r.ascii(3);
  }
  r.seek(attrStart + attrLength);
  return { pid, codingType, format, rate, lang, subPath: streamType !== 1 };
}

function readMarks(r: ByteReader, markPos: number): PlayListMark[] {
  if (markPos === 0) return [];
  r.seek(markPos);
  r.u32(); // length
  const count = r.u16();
  const marks: PlayListMark[] = [];
  for (let i = 0; i < count; i++) {
    r.skip(1);
    const type = r.u8();
    const playItemRef = r.u16();
    const time = r.u32();
    const entryEsPid = r.u16();
    const duration = r.u32();
    marks.push({ type, playItemRef, time, entryEsPid, duration });
  }
  return marks;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/engine/bdmv && npm run typecheck`
Expected: 8 passed (4 index + 4 mpls); typecheck passes.

- [ ] **Step 6: Commit**

```bash
git add src/engine/bdmv tests/helpers/bdmv-builders.ts
git commit -m "feat(engine): parse MPLS playlists, STN tables and marks"
```

---

### Task 5: CLPI clip-info parser with EP-map lookup

**Files:**
- Create: `src/engine/bdmv/clpi-parser.ts`
- Modify: `tests/helpers/bdmv-builders.ts` (append `buildClpi`)
- Test: `src/engine/bdmv/clpi-parser.test.ts`

**Interfaces:**
- Consumes: `ByteReader`, `ParseError`, stream-type helpers, `writeCodingInfo` (Task 4).
- Produces:
  - `interface StcSequence { pcrPid; spnStcStart; presentationStart; presentationEnd /* 45 kHz */ }`
  - `interface AtcSequence { spnAtcStart; offsetStcId; stc: StcSequence[] }`
  - `interface ProgramStream { pid; codingType; format; rate; lang }`
  - `interface ProgramInfo { spnProgramSequenceStart; programMapPid; streams }`
  - `interface EpEntry { pts /* 45 kHz, low 8 bits truncated as on disc */; spn }`
  - `interface EpMap { pid; epStreamType; entries: EpEntry[] /* ascending */ }`
  - `interface Clpi { version; numSourcePackets; atcSequences; programs; epMaps }`
  - `parseClpi(bytes): Clpi`; `findEpBefore(map, pts45): EpEntry | undefined` (the last entry ≤ target, or the first entry if the target precedes all entries); `findEpAfter(map, pts45): EpEntry | undefined` (the first entry > target).
  - Builder: `buildClpi(spec: ClpiSpec)`, where `ClpiSpec { numSourcePackets; streams: {pid; codingType}[]; presentationStart; presentationEnd; epMaps: {pid; entries: {pts; spn}[]}[] }`. EP `pts` is 45 kHz.

EP-map encoding background (libbluray `clpi_parse.c`): each stream has coarse entries `{ref_ep_fine_id:18, pts_ep:14, spn_ep:32}` and fine entries `{angle:1, end_offset:3, pts_ep:11, spn_ep:17}`. A full entry in 45 kHz units is `((coarse.pts & ~1) << 18) + (fine.pts << 8)`, and its SPN is `(coarse.spn & ~0x1FFFF) + fine.spn`. Fine entries `coarse[i].ref … coarse[i+1].ref − 1` belong to coarse entry `i`.

- [ ] **Step 1: Append the CLPI builder** to `tests/helpers/bdmv-builders.ts`

```ts
export interface ClpiSpec {
  numSourcePackets: number;
  streams: Array<{ pid: number; codingType: number }>;
  /** 45 kHz. */
  presentationStart: number;
  /** 45 kHz. */
  presentationEnd: number;
  /** Entry pts are 45 kHz; encoding truncates the low 8 bits, as real discs do. */
  epMaps: Array<{ pid: number; entries: Array<{ pts: number; spn: number }> }>;
}

interface EpGroups {
  coarse: Array<{ ref: number; pts: number; spn: number }>;
  fine: Array<{ pts: number; spn: number }>;
}

function groupEpEntries(entries: ReadonlyArray<{ pts: number; spn: number }>): EpGroups {
  const groups: EpGroups = { coarse: [], fine: [] };
  let lastKey = '';
  entries.forEach((e, i) => {
    const pts90 = e.pts * 2;
    const key = `${Math.floor(pts90 / 2 ** 20)}:${Math.floor(e.spn / 0x20000)}`;
    if (key !== lastKey) {
      groups.coarse.push({ ref: i, pts: Math.floor(pts90 / 2 ** 19) % 0x4000, spn: e.spn });
      lastKey = key;
    }
    groups.fine.push({ pts: Math.floor(pts90 / 2 ** 9) % 0x800, spn: e.spn % 0x20000 });
  });
  return groups;
}

export function buildClpi(spec: ClpiSpec): Uint8Array<ArrayBuffer> {
  const w = new ByteWriter();
  w.ascii('HDMV').ascii('0200');
  const addrAt = w.position;
  w.zeros(20); // sequence, program, cpi, clip mark, extension addresses
  w.zeros(12);

  const clipInfoAt = w.position;
  w.u32(0).u16(0).u8(1).u8(1).u32(0).u32(48_000_000).u32(spec.numSourcePackets).zeros(128).u16(0);
  w.patchU32(clipInfoAt, w.position - clipInfoAt - 4);

  const seqStart = w.position;
  w.u32(0).u8(0).u8(1);
  w.u32(0).u8(1).u8(0); // ATC sequence: spn_atc_start, num_stc_seq, offset_stc_id
  w.u16(0x1001).u32(0).u32(spec.presentationStart).u32(spec.presentationEnd);
  w.patchU32(seqStart, w.position - seqStart - 4);

  const progStart = w.position;
  w.u32(0).u8(0).u8(1);
  w.u32(0).u16(0x0100).u8(spec.streams.length).u8(0);
  for (const s of spec.streams) {
    w.u16(s.pid);
    writeCodingInfo(w, s.codingType);
  }
  w.patchU32(progStart, w.position - progStart - 4);

  const cpiStart = w.position;
  w.u32(0).bits(12, 0).bits(4, 1);
  const epMapStart = w.position;
  w.u8(0).u8(spec.epMaps.length);
  const groups = spec.epMaps.map((m) => groupEpEntries(m.entries));
  const addrSlots: number[] = [];
  spec.epMaps.forEach((m, i) => {
    w.u16(m.pid).bits(10, 0).bits(4, 1).bits(16, groups[i].coarse.length).bits(18, groups[i].fine.length);
    addrSlots.push(w.position);
    w.u32(0);
  });
  groups.forEach((g, i) => {
    const streamStart = w.position;
    w.patchU32(addrSlots[i], streamStart - epMapStart);
    const fineStartAt = w.position;
    w.u32(0);
    for (const c of g.coarse) w.bits(18, c.ref).bits(14, c.pts).u32(c.spn);
    w.patchU32(fineStartAt, w.position - streamStart);
    for (const f of g.fine) w.bits(1, 0).bits(3, 0).bits(11, f.pts).bits(17, f.spn);
  });
  w.patchU32(cpiStart, w.position - cpiStart - 4);

  const clipMarkStart = w.position;
  w.u32(0);

  w.patchU32(addrAt, seqStart).patchU32(addrAt + 4, progStart).patchU32(addrAt + 8, cpiStart).patchU32(addrAt + 12, clipMarkStart);
  return w.toBytes();
}
```

- [ ] **Step 2: Write the failing tests**

`src/engine/bdmv/clpi-parser.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildClpi } from '../../../tests/helpers/bdmv-builders';
import { ParseError } from '../util/byte-reader';
import { findEpAfter, findEpBefore, parseClpi } from './clpi-parser';
import { CodingType } from './stream-types';

const BASE = 450_048; // multiple of 256

function clipWith(entries: Array<{ pts: number; spn: number }>): Uint8Array {
  return buildClpi({
    numSourcePackets: 500_000,
    streams: [
      { pid: 0x1011, codingType: CodingType.AVC },
      { pid: 0x1100, codingType: CodingType.LPCM },
    ],
    presentationStart: BASE,
    presentationEnd: BASE + 450_000,
    epMaps: [{ pid: 0x1011, entries }],
  });
}

describe('parseClpi', () => {
  it('parses clip info, sequences and program streams', () => {
    const clpi = parseClpi(clipWith([{ pts: BASE, spn: 0 }]));
    expect(clpi.version).toBe('0200');
    expect(clpi.numSourcePackets).toBe(500_000);
    expect(clpi.atcSequences[0].stc[0]).toEqual({ pcrPid: 0x1001, spnStcStart: 0, presentationStart: BASE, presentationEnd: BASE + 450_000 });
    expect(clpi.programs[0].streams.map((s) => [s.pid, s.codingType, s.lang])).toEqual([
      [0x1011, CodingType.AVC, ''],
      [0x1100, CodingType.LPCM, 'eng'],
    ]);
  });

  it('reconstructs EP entries from coarse/fine tables, including SPN carries past 0x20000', () => {
    const entries = [
      { pts: BASE, spn: 0 },
      { pts: BASE + 22_528, spn: 0x1fff0 },
      { pts: BASE + 45_056, spn: 0x20010 }, // crosses a 17-bit SPN boundary → new coarse entry
      { pts: BASE + 600_064, spn: 0x50000 }, // crosses a PTS coarse boundary
    ];
    const clpi = parseClpi(clipWith(entries));
    expect(clpi.epMaps).toHaveLength(1);
    expect(clpi.epMaps[0].pid).toBe(0x1011);
    expect(clpi.epMaps[0].entries).toEqual(entries);
  });

  it('truncates the low 8 bits of EP pts like real discs', () => {
    const clpi = parseClpi(clipWith([{ pts: BASE + 1000, spn: 5 }]));
    expect(clpi.epMaps[0].entries[0]).toEqual({ pts: BASE + 768, spn: 5 });
  });

  it('rejects a bad signature', () => {
    const bytes = clipWith([]);
    bytes[0] = 0x00;
    expect(() => parseClpi(bytes)).toThrow(ParseError);
  });
});

describe('EP lookup', () => {
  const map = { pid: 0x1011, epStreamType: 1, entries: [{ pts: 1000, spn: 10 }, { pts: 2000, spn: 20 }, { pts: 3000, spn: 30 }] };

  it('findEpBefore returns the last entry at or before the target', () => {
    expect(findEpBefore(map, 2000)).toEqual({ pts: 2000, spn: 20 });
    expect(findEpBefore(map, 2999)).toEqual({ pts: 2000, spn: 20 });
    expect(findEpBefore(map, 99_999)).toEqual({ pts: 3000, spn: 30 });
  });

  it('findEpBefore falls back to the first entry when the target precedes all entries', () => {
    expect(findEpBefore(map, 5)).toEqual({ pts: 1000, spn: 10 });
    expect(findEpBefore({ ...map, entries: [] }, 5)).toBeUndefined();
  });

  it('findEpAfter returns the first entry strictly after the target', () => {
    expect(findEpAfter(map, 2000)).toEqual({ pts: 3000, spn: 30 });
    expect(findEpAfter(map, 0)).toEqual({ pts: 1000, spn: 10 });
    expect(findEpAfter(map, 3000)).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/engine/bdmv/clpi-parser.test.ts`
Expected: FAIL, because `./clpi-parser` cannot be resolved.

- [ ] **Step 4: Implement `src/engine/bdmv/clpi-parser.ts`**

```ts
import { ByteReader, ParseError } from '../util/byte-reader';
import { CodingType, isAudioCoding, isVideoCoding } from './stream-types';

/** Ported from libbluray bdnav/clpi_parse.c (clip info, sequence info, program info, CPI/EP map). */
export interface StcSequence {
  readonly pcrPid: number;
  readonly spnStcStart: number;
  readonly presentationStart: number;
  readonly presentationEnd: number;
}

export interface AtcSequence {
  readonly spnAtcStart: number;
  readonly offsetStcId: number;
  readonly stc: readonly StcSequence[];
}

export interface ProgramStream {
  readonly pid: number;
  readonly codingType: number;
  readonly format: number;
  readonly rate: number;
  readonly lang: string;
}

export interface ProgramInfo {
  readonly spnProgramSequenceStart: number;
  readonly programMapPid: number;
  readonly streams: readonly ProgramStream[];
}

export interface EpEntry {
  /** 45 kHz; the low 8 bits are not stored on disc. */
  readonly pts: number;
  readonly spn: number;
}

export interface EpMap {
  readonly pid: number;
  readonly epStreamType: number;
  readonly entries: readonly EpEntry[];
}

export interface Clpi {
  readonly version: string;
  readonly numSourcePackets: number;
  readonly atcSequences: readonly AtcSequence[];
  readonly programs: readonly ProgramInfo[];
  readonly epMaps: readonly EpMap[];
}

export function parseClpi(bytes: Uint8Array): Clpi {
  const r = new ByteReader(bytes);
  const signature = r.ascii(4);
  const version = r.ascii(4);
  if (signature !== 'HDMV') throw new ParseError(`clpi: bad signature "${signature}"`);
  const sequenceStart = r.u32();
  const programStart = r.u32();
  const cpiStart = r.u32();
  r.u32(); // clip mark
  r.u32(); // extension data

  r.seek(40);
  r.u32(); // ClipInfo length
  r.skip(2);
  r.u8(); // clip_stream_type
  r.u8(); // application_type
  r.skip(4); // reserved + is_atc_delta
  r.u32(); // ts_recording_rate
  const numSourcePackets = r.u32();

  return {
    version,
    numSourcePackets,
    atcSequences: readSequenceInfo(r, sequenceStart),
    programs: readProgramInfo(r, programStart),
    epMaps: readCpi(r, cpiStart),
  };
}

function readSequenceInfo(r: ByteReader, start: number): AtcSequence[] {
  r.seek(start);
  r.u32();
  r.skip(1);
  const atcCount = r.u8();
  const atcs: AtcSequence[] = [];
  for (let i = 0; i < atcCount; i++) {
    const spnAtcStart = r.u32();
    const stcCount = r.u8();
    const offsetStcId = r.u8();
    const stc: StcSequence[] = [];
    for (let j = 0; j < stcCount; j++) {
      const pcrPid = r.u16();
      const spnStcStart = r.u32();
      const presentationStart = r.u32();
      const presentationEnd = r.u32();
      stc.push({ pcrPid, spnStcStart, presentationStart, presentationEnd });
    }
    atcs.push({ spnAtcStart, offsetStcId, stc });
  }
  return atcs;
}

function readProgramInfo(r: ByteReader, start: number): ProgramInfo[] {
  r.seek(start);
  r.u32();
  r.skip(1);
  const programCount = r.u8();
  const programs: ProgramInfo[] = [];
  for (let i = 0; i < programCount; i++) {
    const spnProgramSequenceStart = r.u32();
    const programMapPid = r.u16();
    const streamCount = r.u8();
    r.u8(); // num_groups
    const streams: ProgramStream[] = [];
    for (let j = 0; j < streamCount; j++) {
      const pid = r.u16();
      const length = r.u8();
      const attrStart = r.position;
      const codingType = r.u8();
      let format = 0;
      let rate = 0;
      let lang = '';
      if (isVideoCoding(codingType)) {
        format = r.bits(4);
        rate = r.bits(4);
      } else if (isAudioCoding(codingType)) {
        format = r.bits(4);
        rate = r.bits(4);
        lang = r.ascii(3);
      } else if (codingType === CodingType.PG || codingType === CodingType.IG) {
        lang = r.ascii(3);
      } else if (codingType === CodingType.TEXT_SUBTITLE) {
        r.skip(1);
        lang = r.ascii(3);
      }
      r.seek(attrStart + length);
      streams.push({ pid, codingType, format, rate, lang });
    }
    programs.push({ spnProgramSequenceStart, programMapPid, streams });
  }
  return programs;
}

function readCpi(r: ByteReader, start: number): EpMap[] {
  if (start === 0) return [];
  r.seek(start);
  const length = r.u32();
  if (length === 0) return [];
  r.skipBits(12);
  const cpiType = r.bits(4);
  if (cpiType !== 1) return [];
  const epMapStart = r.position;
  r.skip(1);
  const pidCount = r.u8();
  const headers: Array<{ pid: number; epStreamType: number; coarseCount: number; fineCount: number; start: number }> = [];
  for (let i = 0; i < pidCount; i++) {
    const pid = r.u16();
    r.skipBits(10);
    const epStreamType = r.bits(4);
    const coarseCount = r.bits(16);
    const fineCount = r.bits(18);
    const start = epMapStart + r.u32();
    headers.push({ pid, epStreamType, coarseCount, fineCount, start });
  }
  return headers.map((h) => {
    r.seek(h.start);
    const fineStart = r.u32();
    const coarse: Array<{ ref: number; pts: number; spn: number }> = [];
    for (let i = 0; i < h.coarseCount; i++) {
      const ref = r.bits(18);
      const pts = r.bits(14);
      const spn = r.u32();
      coarse.push({ ref, pts, spn });
    }
    r.seek(h.start + fineStart);
    const fine: Array<{ pts: number; spn: number }> = [];
    for (let i = 0; i < h.fineCount; i++) {
      r.skipBits(4); // is_angle_change_point, i_end_position_offset
      const pts = r.bits(11);
      const spn = r.bits(17);
      fine.push({ pts, spn });
    }
    const entries: EpEntry[] = [];
    coarse.forEach((c, ci) => {
      const end = ci + 1 < coarse.length ? coarse[ci + 1].ref : fine.length;
      for (let fi = c.ref; fi < end; fi++) {
        entries.push({
          pts: Math.floor(c.pts / 2) * 2 * 2 ** 18 + fine[fi].pts * 2 ** 8,
          spn: Math.floor(c.spn / 0x20000) * 0x20000 + fine[fi].spn,
        });
      }
    });
    return { pid: h.pid, epStreamType: h.epStreamType, entries };
  });
}

/** Last entry with pts ≤ target; the first entry if the target precedes all entries; undefined if empty. */
export function findEpBefore(map: EpMap, pts45: number): EpEntry | undefined {
  const entries = map.entries;
  let lo = 0;
  let hi = entries.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].pts <= pts45) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return entries[Math.max(found, 0)];
}

/** First entry with pts > target, or undefined. */
export function findEpAfter(map: EpMap, pts45: number): EpEntry | undefined {
  return map.entries.find((e) => e.pts > pts45);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/engine/bdmv && npm run typecheck`
Expected: 15 passed; typecheck passes.

- [ ] **Step 6: Commit**

```bash
git add src/engine/bdmv tests/helpers/bdmv-builders.ts
git commit -m "feat(engine): parse CLPI clip info and EP maps with entry-point lookup"
```

---

### Task 6: Disc access: paths, FileSource, time units, openDisc

**Files:**
- Create: `src/engine/disc/byte-source.ts`, `src/engine/disc/paths.ts`, `src/engine/disc/file-source.ts`, `src/engine/disc/open-disc.ts`, `src/engine/demux/constants.ts`, `src/engine/util/time.ts`
- Test: `src/engine/disc/paths.test.ts`, `src/engine/disc/file-source.test.ts`, `src/engine/disc/open-disc.test.ts`, `src/engine/util/time.test.ts`

**Interfaces:**
- Consumes: `parseIndex`, `indexUsesBdj`, `parseMpls`, `MarkType`, `parseClpi`, `ParseError`; builders from Tasks 3–5.
- Produces:
  - `interface ByteSource { exists(path): boolean; size(path): number; list(dir): string[]; read(path, offset, length): Promise<Uint8Array> }`
  - `type DiscErrorCode = 'not-bdmv' | 'multiple-discs' | 'missing-file' | 'source-changed' | 'encrypted' | 'unreadable-stream' | 'read-failed'`
  - `class DiscError extends Error { code; paths }`; `readWhole(source, path)`
  - `normalizeDiscPaths(entries: ReadonlyArray<readonly [string, Blob]>): Map<string, Blob>`. Keys are upper-case and relative to the folder that contains `BDMV`.
  - `class FileSource implements ByteSource` (constructed from `ReadonlyMap<string, Blob>`)
  - `playlistPath(id)`, `clipInfoPath(clipId)`, `streamPath(clipId)`
  - `interface PlaylistSummary { id; durationUs; chapterCount; clipIds; playable; missingPaths }`
  - `interface DiscModel { index; usesBdj; playlists: ReadonlyMap<string, Mpls>; summaries (longest first); warnings }`
  - `openDisc(source): Promise<DiscModel>`, `loadClips(source, clipIds): Promise<Map<string, Clpi>>`, `checkStreamReadable(source, clipId): Promise<void>`
  - `SOURCE_PACKET_SIZE = 192`, `PACKETS_PER_ALIGNED_UNIT = 32`, `ALIGNED_UNIT_SIZE = 6144`, `NULL_PID = 0x1fff`
  - `PTS_WRAP`, `ticks45ToUs`, `usToTicks45`, `pts90ToUs`, `ptsDelta90(a, b)` (the signed `a − b` modulo 2^33)

Note: the spec describes read-ahead "in the FileSource". In this plan `FileSource` does plain ranged reads, and `M2tsReader` (Task 8) does the 2 MB aligned read-ahead and prefetch. The behavior is the same, and parser reads don't need a cache.

- [ ] **Step 1: Write the failing tests for time units**

`src/engine/util/time.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { PTS_WRAP, pts90ToUs, ptsDelta90, ticks45ToUs, usToTicks45 } from './time';

describe('time units', () => {
  it('converts 45 kHz ticks, 90 kHz PTS and microseconds', () => {
    expect(ticks45ToUs(45_000)).toBe(1_000_000);
    expect(usToTicks45(2_000_000)).toBe(90_000);
    expect(pts90ToUs(90_000)).toBe(1_000_000);
    expect(ticks45ToUs(1)).toBe(22);
  });

  it('computes signed PTS differences across the 33-bit wrap', () => {
    expect(ptsDelta90(1000, 400)).toBe(600);
    expect(ptsDelta90(400, 1000)).toBe(-600);
    expect(ptsDelta90(100, PTS_WRAP - 100)).toBe(200);
    expect(ptsDelta90(PTS_WRAP - 100, 100)).toBe(-200);
  });
});
```

- [ ] **Step 2: Implement `src/engine/util/time.ts` and `src/engine/demux/constants.ts`**

`src/engine/util/time.ts`:
```ts
/** PTS values are 33-bit, 90 kHz. Navigation times (MPLS/CLPI) are 45 kHz. */
export const PTS_WRAP = 2 ** 33;

export function ticks45ToUs(ticks: number): number {
  return Math.round((ticks * 200) / 9);
}

export function usToTicks45(us: number): number {
  return Math.round((us * 9) / 200);
}

export function pts90ToUs(pts: number): number {
  return Math.round((pts * 100) / 9);
}

/** Signed a − b in 90 kHz units, treating both as points on the 33-bit wrapping PTS line. */
export function ptsDelta90(a: number, b: number): number {
  let d = (a - b) % PTS_WRAP;
  if (d > PTS_WRAP / 2) d -= PTS_WRAP;
  else if (d <= -PTS_WRAP / 2) d += PTS_WRAP;
  return d;
}
```

`src/engine/demux/constants.ts`:
```ts
/** 4-byte TP_extra_header + 188-byte transport packet. */
export const SOURCE_PACKET_SIZE = 192;
export const PACKETS_PER_ALIGNED_UNIT = 32;
export const ALIGNED_UNIT_SIZE = SOURCE_PACKET_SIZE * PACKETS_PER_ALIGNED_UNIT;
export const NULL_PID = 0x1fff;
```

Run: `npx vitest run src/engine/util/time.test.ts`
Expected: 2 passed.

- [ ] **Step 3: Write the failing tests for paths and FileSource**

`src/engine/disc/paths.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { DiscError } from './byte-source';
import { normalizeDiscPaths } from './paths';

const blob = new Blob(['x']);
const keys = (paths: string[]): string[] => [...normalizeDiscPaths(paths.map((p) => [p, blob] as const)).keys()].sort();

describe('normalizeDiscPaths', () => {
  it('accepts the disc root folder and keeps siblings of BDMV', () => {
    expect(keys(['MyMovie/BDMV/index.bdmv', 'MyMovie/BDMV/PLAYLIST/00000.mpls', 'MyMovie/AACS/Unit_Key_RO.inf'])).toEqual([
      'AACS/UNIT_KEY_RO.INF',
      'BDMV/INDEX.BDMV',
      'BDMV/PLAYLIST/00000.MPLS',
    ]);
  });

  it('accepts the BDMV folder itself', () => {
    expect(keys(['BDMV/index.bdmv', 'BDMV/STREAM/00000.m2ts'])).toEqual(['BDMV/INDEX.BDMV', 'BDMV/STREAM/00000.M2TS']);
  });

  it('accepts a parent folder containing exactly one disc and ignores unrelated files', () => {
    expect(keys(['Discs/MyMovie/BDMV/index.bdmv', 'Discs/notes.txt'])).toEqual(['BDMV/INDEX.BDMV']);
  });

  it('accepts a lower-case bdmv folder', () => {
    expect(keys(['disc/bdmv/index.bdmv'])).toEqual(['BDMV/INDEX.BDMV']);
  });

  it('rejects a folder containing two discs', () => {
    try {
      keys(['Discs/A/BDMV/index.bdmv', 'Discs/B/BDMV/index.bdmv']);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DiscError);
      expect((err as DiscError).code).toBe('multiple-discs');
      expect((err as DiscError).paths).toEqual(['Discs/A', 'Discs/B']);
    }
  });

  it('rejects a selection without a BDMV folder', () => {
    expect(() => keys(['Photos/a.jpg'])).toThrow(DiscError);
  });
});
```

`src/engine/disc/file-source.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { DiscError } from './byte-source';
import { FileSource } from './file-source';

function source(): FileSource {
  return new FileSource(
    new Map<string, Blob>([
      ['BDMV/INDEX.BDMV', new Blob([new Uint8Array([1, 2, 3, 4, 5])])],
      ['BDMV/PLAYLIST/00000.MPLS', new Blob(['a'])],
      ['BDMV/PLAYLIST/00001.MPLS', new Blob(['b'])],
      ['BDMV/PLAYLIST/SUB/IGNORED.MPLS', new Blob(['c'])],
    ]),
  );
}

describe('FileSource', () => {
  it('answers exists/size/list case-insensitively', () => {
    const s = source();
    expect(s.exists('bdmv/index.bdmv')).toBe(true);
    expect(s.exists('BDMV/MovieObject.bdmv')).toBe(false);
    expect(s.size('BDMV/INDEX.BDMV')).toBe(5);
    expect(s.list('BDMV/PLAYLIST')).toEqual(['00000.MPLS', '00001.MPLS']);
    expect(s.list('AACS')).toEqual([]);
  });

  it('reads byte ranges and clamps at end of file', async () => {
    const s = source();
    expect(Array.from(await s.read('BDMV/INDEX.BDMV', 1, 2))).toEqual([2, 3]);
    expect(Array.from(await s.read('BDMV/INDEX.BDMV', 3, 100))).toEqual([4, 5]);
    expect((await s.read('BDMV/INDEX.BDMV', 9, 4)).length).toBe(0);
  });

  it('throws missing-file for unknown paths', async () => {
    await expect(source().read('BDMV/STREAM/00000.M2TS', 0, 1)).rejects.toMatchObject({ code: 'missing-file' });
    expect(() => source().size('BDMV/STREAM/00000.M2TS')).toThrow(DiscError);
  });

  it('maps NotReadableError to source-changed and other failures to read-failed', async () => {
    const failing = (err: unknown): Blob =>
      ({ size: 10, slice: () => ({ arrayBuffer: () => Promise.reject(err) }) }) as unknown as Blob;
    const changed = new FileSource(new Map([['A', failing(new DOMException('gone', 'NotReadableError'))]]));
    await expect(changed.read('A', 0, 4)).rejects.toMatchObject({ code: 'source-changed' });
    const broken = new FileSource(new Map([['A', failing(new Error('boom'))]]));
    await expect(broken.read('A', 0, 4)).rejects.toMatchObject({ code: 'read-failed' });
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run src/engine/disc`
Expected: FAIL, because `./byte-source`, `./paths` and `./file-source` cannot be resolved.

- [ ] **Step 5: Implement `byte-source.ts`, `paths.ts`, `file-source.ts`**

`src/engine/disc/byte-source.ts`:
```ts
/** The only way engine modules touch disc bytes. Later phases add ISO (UDF) and AACS implementations. */
export interface ByteSource {
  exists(path: string): boolean;
  size(path: string): number;
  /** File names directly inside `dir`, sorted. */
  list(dir: string): string[];
  read(path: string, offset: number, length: number): Promise<Uint8Array>;
}

export type DiscErrorCode =
  | 'not-bdmv'
  | 'multiple-discs'
  | 'missing-file'
  | 'source-changed'
  | 'encrypted'
  | 'unreadable-stream'
  | 'read-failed';

export class DiscError extends Error {
  constructor(
    readonly code: DiscErrorCode,
    message: string,
    readonly paths: readonly string[] = [],
  ) {
    super(message);
    this.name = 'DiscError';
  }
}

export function readWhole(source: ByteSource, path: string): Promise<Uint8Array> {
  return source.read(path, 0, source.size(path));
}
```

`src/engine/disc/paths.ts`:
```ts
import { DiscError } from './byte-source';

/**
 * Maps picked files (relative paths as reported by the picker) to disc-relative upper-case paths,
 * rooted at the folder that contains BDMV. Accepts the disc root, the BDMV folder itself, or a
 * parent folder containing exactly one disc.
 */
export function normalizeDiscPaths(entries: ReadonlyArray<readonly [string, Blob]>): Map<string, Blob> {
  const roots = new Set<string>();
  for (const [path] of entries) {
    const segments = path.split('/').filter(Boolean);
    const bdmvAt = segments.findIndex((s) => s.toUpperCase() === 'BDMV');
    if (bdmvAt >= 0) roots.add(segments.slice(0, bdmvAt).join('/'));
  }
  if (roots.size === 0) throw new DiscError('not-bdmv', 'No BDMV folder was found in the selected folder.');
  if (roots.size > 1) {
    throw new DiscError('multiple-discs', 'The selected folder contains more than one disc. Pick a single disc folder.', [...roots].sort());
  }
  const [root] = [...roots];
  const prefix = root === '' ? '' : `${root}/`;
  const files = new Map<string, Blob>();
  for (const [path, blob] of entries) {
    const relative = path.split('/').filter(Boolean).join('/');
    if (prefix !== '' && !relative.startsWith(prefix)) continue;
    files.set(relative.slice(prefix.length).toUpperCase(), blob);
  }
  return files;
}
```

`src/engine/disc/file-source.ts`:
```ts
import { DiscError, type ByteSource } from './byte-source';

/** ByteSource over picked files. Blob.slice() reads only the requested range from disk. */
export class FileSource implements ByteSource {
  constructor(private readonly files: ReadonlyMap<string, Blob>) {}

  exists(path: string): boolean {
    return this.files.has(path.toUpperCase());
  }

  size(path: string): number {
    return this.get(path).size;
  }

  list(dir: string): string[] {
    const prefix = `${dir.toUpperCase().replace(/\/$/, '')}/`;
    const names: string[] = [];
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest !== '' && !rest.includes('/')) names.push(rest);
    }
    return names.sort();
  }

  async read(path: string, offset: number, length: number): Promise<Uint8Array> {
    const blob = this.get(path);
    const end = Math.min(offset + length, blob.size);
    if (offset >= end) return new Uint8Array(0);
    try {
      return new Uint8Array(await blob.slice(offset, end).arrayBuffer());
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotReadableError') {
        throw new DiscError('source-changed', 'The disc folder changed on disk. Please reopen it.', [path]);
      }
      throw new DiscError('read-failed', `Failed to read ${path}: ${String(err)}`, [path]);
    }
  }

  private get(path: string): Blob {
    const blob = this.files.get(path.toUpperCase());
    if (!blob) throw new DiscError('missing-file', `Missing file ${path}`, [path]);
    return blob;
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/engine/disc src/engine/util`
Expected: all pass.

- [ ] **Step 7: Write the failing `openDisc` tests**

`src/engine/disc/open-disc.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildClpi, buildIndex, buildMpls } from '../../../tests/helpers/bdmv-builders';
import { CodingType } from '../bdmv/stream-types';
import { DiscError } from './byte-source';
import { FileSource } from './file-source';
import { checkStreamReadable, loadClips, openDisc } from './open-disc';
import { normalizeDiscPaths } from './paths';

const VIDEO = [{ pid: 0x1011, codingType: CodingType.AVC }];

function m2ts(packets: number, syncedPackets = packets): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(packets * 192);
  for (let k = 0; k < syncedPackets; k++) bytes[k * 192 + 4] = 0x47;
  return bytes;
}

function clpi(): Uint8Array<ArrayBuffer> {
  return buildClpi({ numSourcePackets: 64, streams: VIDEO, presentationStart: 0, presentationEnd: 45_000, epMaps: [{ pid: 0x1011, entries: [{ pts: 0, spn: 0 }] }] });
}

function disc(files: Record<string, Uint8Array<ArrayBuffer>>): FileSource {
  return new FileSource(normalizeDiscPaths(Object.entries(files).map(([p, b]) => [p, new Blob([b])] as const)));
}

function baseFiles(): Record<string, Uint8Array<ArrayBuffer>> {
  return {
    'Movie/BDMV/index.bdmv': buildIndex({ firstPlay: { kind: 'hdmv', movieObjectId: 0 }, topMenu: { kind: 'hdmv', movieObjectId: 1 }, titles: [] }),
    'Movie/BDMV/PLAYLIST/00000.mpls': buildMpls({
      playItems: [
        { clipId: '00001', inTime: 0, outTime: 450_000, video: VIDEO },
        { clipId: '00002', inTime: 0, outTime: 225_000, video: VIDEO },
      ],
      marks: [
        { playItemRef: 0, time: 0 },
        { playItemRef: 1, time: 0 },
        { playItemRef: 1, time: 100, type: 2 },
      ],
    }),
    'Movie/BDMV/PLAYLIST/00001.mpls': buildMpls({ playItems: [{ clipId: '00002', inTime: 0, outTime: 45_000, video: VIDEO }] }),
    'Movie/BDMV/CLIPINF/00001.clpi': clpi(),
    'Movie/BDMV/CLIPINF/00002.clpi': clpi(),
    'Movie/BDMV/STREAM/00001.m2ts': m2ts(64),
    'Movie/BDMV/STREAM/00002.m2ts': m2ts(64),
  };
}

describe('openDisc', () => {
  it('summarizes playlists longest first', async () => {
    const model = await openDisc(disc(baseFiles()));
    expect(model.usesBdj).toBe(false);
    expect(model.summaries.map((s) => [s.id, s.durationUs, s.chapterCount, s.playable])).toEqual([
      ['00000', 15_000_000, 2, true],
      ['00001', 1_000_000, 0, true],
    ]);
    expect(model.summaries[0].clipIds).toEqual(['00001', '00002']);
    expect(model.playlists.get('00000')?.playItems).toHaveLength(2);
  });

  it('marks playlists with missing clip files as not playable', async () => {
    const files = baseFiles();
    delete files['Movie/BDMV/STREAM/00002.m2ts'];
    const model = await openDisc(disc(files));
    expect(model.summaries.every((s) => !s.playable)).toBe(true);
    expect(model.summaries[0].missingPaths).toEqual(['BDMV/STREAM/00002.M2TS']);
  });

  it('rejects a folder without index.bdmv', async () => {
    const files = baseFiles();
    delete files['Movie/BDMV/index.bdmv'];
    await expect(openDisc(disc(files))).rejects.toMatchObject({ code: 'not-bdmv', paths: ['BDMV/INDEX.BDMV'] });
  });

  it('skips damaged playlists with a warning', async () => {
    const files = baseFiles();
    files['Movie/BDMV/PLAYLIST/00001.mpls'] = new Uint8Array([0x4d, 0x50]);
    const model = await openDisc(disc(files));
    expect(model.summaries.map((s) => s.id)).toEqual(['00000']);
    expect(model.warnings[0]).toContain('00001');
  });

  it('reports an encrypted disc when AACS is present and the stream does not parse', async () => {
    const files = baseFiles();
    files['Movie/BDMV/STREAM/00001.m2ts'] = m2ts(64, 1);
    files['Movie/AACS/Unit_Key_RO.inf'] = new Uint8Array(16);
    await expect(openDisc(disc(files))).rejects.toMatchObject({ code: 'encrypted' });
  });

  it('reports an unreadable stream when it does not parse and there is no AACS folder', async () => {
    const files = baseFiles();
    files['Movie/BDMV/STREAM/00001.m2ts'] = m2ts(64, 1);
    await expect(checkStreamReadable(disc(files), '00001')).rejects.toBeInstanceOf(DiscError);
    await expect(checkStreamReadable(disc(files), '00001')).rejects.toMatchObject({ code: 'unreadable-stream' });
  });

  it('loads clip info for a list of clips', async () => {
    const clips = await loadClips(disc(baseFiles()), ['00001', '00002']);
    expect([...clips.keys()]).toEqual(['00001', '00002']);
    expect(clips.get('00001')?.epMaps[0].entries).toEqual([{ pts: 0, spn: 0 }]);
  });
});
```

- [ ] **Step 8: Run the tests to verify they fail**

Run: `npx vitest run src/engine/disc/open-disc.test.ts`
Expected: FAIL, because `./open-disc` cannot be resolved.

- [ ] **Step 9: Implement `src/engine/disc/open-disc.ts`**

```ts
import { parseClpi, type Clpi } from '../bdmv/clpi-parser';
import { indexUsesBdj, parseIndex, type IndexBdmv } from '../bdmv/index-parser';
import { MarkType, parseMpls, type Mpls } from '../bdmv/mpls-parser';
import { ALIGNED_UNIT_SIZE, SOURCE_PACKET_SIZE } from '../demux/constants';
import { ParseError } from '../util/byte-reader';
import { ticks45ToUs } from '../util/time';
import { DiscError, readWhole, type ByteSource } from './byte-source';

const INDEX_PATH = 'BDMV/INDEX.BDMV';

export const playlistPath = (id: string): string => `BDMV/PLAYLIST/${id}.MPLS`;
export const clipInfoPath = (clipId: string): string => `BDMV/CLIPINF/${clipId}.CLPI`;
export const streamPath = (clipId: string): string => `BDMV/STREAM/${clipId}.M2TS`;

export interface PlaylistSummary {
  readonly id: string;
  readonly durationUs: number;
  readonly chapterCount: number;
  readonly clipIds: readonly string[];
  readonly playable: boolean;
  readonly missingPaths: readonly string[];
}

export interface DiscModel {
  readonly index: IndexBdmv;
  readonly usesBdj: boolean;
  readonly playlists: ReadonlyMap<string, Mpls>;
  /** Longest first. */
  readonly summaries: readonly PlaylistSummary[];
  readonly warnings: readonly string[];
}

export async function openDisc(source: ByteSource): Promise<DiscModel> {
  const playlistFiles = source.list('BDMV/PLAYLIST').filter((name) => name.endsWith('.MPLS'));
  const missing: string[] = [];
  if (!source.exists(INDEX_PATH)) missing.push(INDEX_PATH);
  if (playlistFiles.length === 0) missing.push('BDMV/PLAYLIST/*.MPLS');
  if (missing.length > 0) throw new DiscError('not-bdmv', 'This folder is not a Blu-ray (BDMV) backup.', missing);

  let index: IndexBdmv;
  try {
    index = parseIndex(await readWhole(source, INDEX_PATH));
  } catch (err) {
    if (err instanceof ParseError) throw new DiscError('not-bdmv', `index.bdmv is damaged: ${err.message}`, [INDEX_PATH]);
    throw err;
  }

  const playlists = new Map<string, Mpls>();
  const warnings: string[] = [];
  for (const name of playlistFiles) {
    const id = name.slice(0, -'.MPLS'.length);
    try {
      playlists.set(id, parseMpls(await readWhole(source, playlistPath(id))));
    } catch (err) {
      if (!(err instanceof ParseError)) throw err;
      warnings.push(`Skipped playlist ${id}: ${err.message}`);
    }
  }

  const summaries = [...playlists]
    .map(([id, mpls]) => summarize(source, id, mpls))
    .sort((a, b) => b.durationUs - a.durationUs || a.id.localeCompare(b.id));
  const main = summaries.find((s) => s.playable);
  if (main) await checkStreamReadable(source, main.clipIds[0]);
  return { index, usesBdj: indexUsesBdj(index), playlists, summaries, warnings };
}

function summarize(source: ByteSource, id: string, mpls: Mpls): PlaylistSummary {
  const clipIds = [...new Set(mpls.playItems.map((p) => p.clipId))];
  const missingPaths = clipIds.flatMap((c) => [clipInfoPath(c), streamPath(c)]).filter((p) => !source.exists(p));
  const duration45 = mpls.playItems.reduce((sum, p) => sum + Math.max(0, p.outTime - p.inTime), 0);
  const hasVideo = mpls.playItems.length > 0 && mpls.playItems[0].stn.video.some((v) => !v.subPath);
  return {
    id,
    durationUs: ticks45ToUs(duration45),
    chapterCount: mpls.marks.filter((m) => m.type === MarkType.ENTRY).length,
    clipIds,
    playable: hasVideo && missingPaths.length === 0,
    missingPaths,
  };
}

export async function loadClips(source: ByteSource, clipIds: readonly string[]): Promise<Map<string, Clpi>> {
  const clips = new Map<string, Clpi>();
  for (const clipId of clipIds) {
    const path = clipInfoPath(clipId);
    if (!source.exists(path)) throw new DiscError('missing-file', `Missing clip info ${path}`, [path]);
    clips.set(clipId, parseClpi(await readWhole(source, path)));
  }
  return clips;
}

/** Encrypted aligned units keep only the first 16 bytes in the clear, so later packets lose their sync byte. */
export async function checkStreamReadable(source: ByteSource, clipId: string): Promise<void> {
  const path = streamPath(clipId);
  const bytes = await source.read(path, 0, ALIGNED_UNIT_SIZE);
  const packets = Math.floor(bytes.length / SOURCE_PACKET_SIZE);
  let readable = packets > 0;
  for (let k = 0; k < packets && readable; k++) {
    if (bytes[k * SOURCE_PACKET_SIZE + 4] !== 0x47) readable = false;
  }
  if (readable) return;
  if (source.list('AACS').length > 0) {
    throw new DiscError('encrypted', 'This disc appears to be encrypted (AACS). Only decrypted backups are supported.', [path]);
  }
  throw new DiscError('unreadable-stream', 'The video stream could not be read. The backup may be damaged or encrypted.', [path]);
}
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `npx vitest run src/engine && npm run typecheck`
Expected: all pass.

- [ ] **Step 11: Commit**

```bash
git add src/engine/disc src/engine/util/time.ts src/engine/util/time.test.ts src/engine/demux/constants.ts
git commit -m "feat(engine): open BDMV folders, summarize playlists, detect encrypted streams"
```

---

### Task 7: Playlist timeline

**Files:**
- Create: `src/engine/nav/timeline.ts`
- Test: `src/engine/nav/timeline.test.ts`

**Interfaces:**
- Consumes: `PlayItem`, `PlayListMark`, `MarkType` (Task 4); time helpers (Task 6).
- Produces:
  - `interface TimelineItem { index; clipId; inTime; outTime; start /* 45 kHz playlist time */; connectionCondition }`
  - `interface Chapter { index; startUs }`
  - `interface ItemPosition { item: TimelineItem; clipTime45: number }`
  - `class Timeline(playItems)` with:
    - `items`, `duration45`, `durationUs`, `itemStartUs(i)`
    - `locate(playlistUs): ItemPosition`, which clamps to `[0, duration)`. An exact boundary resolves to the later item.
    - `toPlaylistUs(itemIndex, pts90): { us: number; inRange: boolean }`
    - `chapters(marks): Chapter[]`

- [ ] **Step 1: Write the failing tests**

`src/engine/nav/timeline.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { PlayItem } from '../bdmv/mpls-parser';
import { MarkType } from '../bdmv/mpls-parser';
import { PTS_WRAP } from '../util/time';
import { Timeline } from './timeline';

function item(clipId: string, inTime: number, outTime: number): PlayItem {
  return {
    clipId,
    codecId: 'M2TS',
    connectionCondition: 1,
    stcId: 0,
    inTime,
    outTime,
    uoMask: new Uint8Array(8),
    stillMode: 0,
    stillTime: 0,
    isMultiAngle: false,
    angleClipIds: [],
    stn: { video: [], audio: [], pg: [], ig: [] },
  };
}

// Item A: 10 s starting at clip time 20 s. Item B: 5 s starting at clip time 10 s.
const timeline = new Timeline([item('A', 900_000, 1_350_000), item('B', 450_000, 675_000)]);

describe('Timeline', () => {
  it('lays play items end to end', () => {
    expect(timeline.durationUs).toBe(15_000_000);
    expect(timeline.items.map((i) => i.start)).toEqual([0, 450_000]);
    expect(timeline.itemStartUs(1)).toBe(10_000_000);
  });

  it('locates playlist times, resolving boundaries to the later item and clamping', () => {
    expect(timeline.locate(0)).toMatchObject({ item: { clipId: 'A' }, clipTime45: 900_000 });
    expect(timeline.locate(9_999_000)).toMatchObject({ item: { clipId: 'A' } });
    expect(timeline.locate(10_000_000)).toMatchObject({ item: { clipId: 'B' }, clipTime45: 450_000 });
    expect(timeline.locate(-5)).toMatchObject({ item: { clipId: 'A' }, clipTime45: 900_000 });
    expect(timeline.locate(99_000_000)).toMatchObject({ item: { clipId: 'B' }, clipTime45: 674_999 });
  });

  it('maps clip PTS to playlist time and flags out-of-range PTS', () => {
    expect(timeline.toPlaylistUs(0, 1_800_000)).toEqual({ us: 0, inRange: true });
    expect(timeline.toPlaylistUs(0, 1_890_000)).toEqual({ us: 1_000_000, inRange: true });
    expect(timeline.toPlaylistUs(0, 2_700_000)).toEqual({ us: 10_000_000, inRange: false });
    expect(timeline.toPlaylistUs(0, 1_710_000)).toEqual({ us: -1_000_000, inRange: false });
    expect(timeline.toPlaylistUs(1, 900_000)).toEqual({ us: 10_000_000, inRange: true });
  });

  it('handles the 33-bit PTS wrap inside a play item', () => {
    const inTime = 0xfffff000; // 45 kHz, so in90 is just below 2^33
    const wrapped = new Timeline([item('W', inTime, inTime + 450_000)]);
    const pts90 = inTime * 2 + 90_000 - PTS_WRAP;
    expect(wrapped.toPlaylistUs(0, pts90)).toEqual({ us: 1_000_000, inRange: true });
  });

  it('derives chapters from entry marks only', () => {
    const marks = [
      { type: MarkType.ENTRY, playItemRef: 0, time: 900_000, entryEsPid: 0, duration: 0 },
      { type: MarkType.ENTRY, playItemRef: 0, time: 1_125_000, entryEsPid: 0, duration: 0 },
      { type: MarkType.LINK, playItemRef: 1, time: 500_000, entryEsPid: 0, duration: 0 },
      { type: MarkType.ENTRY, playItemRef: 1, time: 450_000, entryEsPid: 0, duration: 0 },
      { type: MarkType.ENTRY, playItemRef: 7, time: 0, entryEsPid: 0, duration: 0 },
    ];
    expect(timeline.chapters(marks)).toEqual([
      { index: 0, startUs: 0 },
      { index: 1, startUs: 5_000_000 },
      { index: 2, startUs: 10_000_000 },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/engine/nav`
Expected: FAIL, because `./timeline` cannot be resolved.

- [ ] **Step 3: Implement `src/engine/nav/timeline.ts`**

```ts
import { MarkType, type PlayItem, type PlayListMark } from '../bdmv/mpls-parser';
import { pts90ToUs, ptsDelta90, ticks45ToUs, usToTicks45 } from '../util/time';

export interface TimelineItem {
  readonly index: number;
  readonly clipId: string;
  /** 45 kHz clip time. */
  readonly inTime: number;
  readonly outTime: number;
  /** 45 kHz playlist time at which this item starts. */
  readonly start: number;
  readonly connectionCondition: number;
}

export interface Chapter {
  readonly index: number;
  readonly startUs: number;
}

export interface ItemPosition {
  readonly item: TimelineItem;
  readonly clipTime45: number;
}

/** Maps between continuous playlist time and per-clip PTS (libbluray navigation.c time math). */
export class Timeline {
  readonly items: readonly TimelineItem[];
  readonly duration45: number;

  constructor(playItems: readonly PlayItem[]) {
    const items: TimelineItem[] = [];
    let start = 0;
    playItems.forEach((p, index) => {
      items.push({ index, clipId: p.clipId, inTime: p.inTime, outTime: p.outTime, start, connectionCondition: p.connectionCondition });
      start += Math.max(0, p.outTime - p.inTime);
    });
    this.items = items;
    this.duration45 = start;
  }

  get durationUs(): number {
    return ticks45ToUs(this.duration45);
  }

  itemStartUs(index: number): number {
    return ticks45ToUs(this.items[index].start);
  }

  locate(playlistUs: number): ItemPosition {
    if (this.items.length === 0) throw new Error('Timeline has no play items');
    const t = Math.min(Math.max(0, usToTicks45(playlistUs)), Math.max(0, this.duration45 - 1));
    let item = this.items[0];
    for (const candidate of this.items) {
      if (candidate.start > t) break;
      if (candidate.outTime > candidate.inTime) item = candidate;
    }
    return { item, clipTime45: item.inTime + (t - item.start) };
  }

  toPlaylistUs(itemIndex: number, pts90: number): { us: number; inRange: boolean } {
    const item = this.items[itemIndex];
    const delta90 = ptsDelta90(pts90, item.inTime * 2);
    const length90 = (item.outTime - item.inTime) * 2;
    return { us: ticks45ToUs(item.start) + pts90ToUs(delta90), inRange: delta90 >= 0 && delta90 < length90 };
  }

  chapters(marks: readonly PlayListMark[]): Chapter[] {
    const starts = marks
      .filter((m) => m.type === MarkType.ENTRY && m.playItemRef < this.items.length)
      .map((m) => {
        const item = this.items[m.playItemRef];
        return ticks45ToUs(item.start + Math.max(0, m.time - item.inTime));
      });
    return [...new Set(starts)].sort((a, b) => a - b).map((startUs, index) => ({ index, startUs }));
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/engine/nav && npm run typecheck`
Expected: 5 passed; typecheck passes.

- [ ] **Step 5: Commit**

```bash
git add src/engine/nav
git commit -m "feat(engine): map playlist time to clip PTS across play items"
```

---

### Task 8: M2TS demux: source packets, PES reassembly, chunked reader

**Files:**
- Create: `src/engine/demux/ts-packet.ts`, `src/engine/demux/pes-assembler.ts`, `src/engine/demux/m2ts-reader.ts`, `tests/helpers/ts-muxer.ts`
- Test: `src/engine/demux/ts-packet.test.ts`, `src/engine/demux/pes-assembler.test.ts`, `src/engine/demux/m2ts-reader.test.ts`

**Interfaces:**
- Consumes: `ByteSource`, `FileSource` (Task 6); demux constants (Task 6).
- Produces:
  - `interface TsPacket { pid; payloadUnitStart; continuityCounter; hasPayload; payload }`; `parseSourcePacket(buf, offset): TsPacket | null`
  - `interface PesPacket { pid; streamId; pts?: number /* 90 kHz */; dts?: number; payload }`; `class PesAssembler(onPes)` with `push`, `flush`, `reset`, `continuityErrors`; `readTimestamp(bytes, offset)`
  - `interface M2tsReaderOptions { source; path; startSpn; endSpn?; pids: ReadonlySet<number>; chunkPackets? }`; `interface DemuxStats { corruptPackets; continuityErrors }`; `class M2tsReader(opts)` with `next(): Promise<PesPacket[] | null>` and `stats`
  - Test helper: `muxM2ts(units: MuxUnit[]): { bytes; unitSpns }`, where `MuxUnit { pid; streamId; pts; dts?; payload }`. Units are written in the given order. Each unit's first packet SPN is reported, and the output is padded to whole aligned units with null packets.

- [ ] **Step 1: Write the test muxer**

`tests/helpers/ts-muxer.ts`:
```ts
export interface MuxUnit {
  pid: number;
  streamId: number;
  /** 90 kHz. */
  pts: number;
  dts?: number;
  payload: Uint8Array;
}

export interface MuxResult {
  bytes: Uint8Array<ArrayBuffer>;
  /** Source packet number of each unit's first packet. */
  unitSpns: number[];
}

export function writeTimestamp(out: Uint8Array, offset: number, prefix: number, ts: number): void {
  const low30 = ts % 0x40000000;
  const high3 = Math.floor(ts / 0x40000000) & 0x7;
  out[offset] = (prefix << 4) | (high3 << 1) | 1;
  out[offset + 1] = (low30 >>> 22) & 0xff;
  out[offset + 2] = (((low30 >>> 15) & 0x7f) << 1) | 1;
  out[offset + 3] = (low30 >>> 7) & 0xff;
  out[offset + 4] = ((low30 & 0x7f) << 1) | 1;
}

function buildPes(u: MuxUnit): Uint8Array {
  const hasDts = u.dts !== undefined && u.dts !== u.pts;
  const headerDataLength = hasDts ? 10 : 5;
  const length = 3 + headerDataLength + u.payload.length;
  const out = new Uint8Array(6 + length);
  out.set([0, 0, 1, u.streamId], 0);
  const declared = length > 0xffff ? 0 : length;
  out[4] = declared >> 8;
  out[5] = declared & 0xff;
  out[6] = 0x80;
  out[7] = hasDts ? 0xc0 : 0x80;
  out[8] = headerDataLength;
  writeTimestamp(out, 9, hasDts ? 0x3 : 0x2, u.pts);
  if (hasDts && u.dts !== undefined) writeTimestamp(out, 14, 0x1, u.dts);
  out.set(u.payload, 9 + headerDataLength);
  return out;
}

function sourcePacket(index: number): Uint8Array {
  const pkt = new Uint8Array(192);
  const ats = index & 0x3fffffff;
  pkt[0] = (ats >>> 24) & 0x3f;
  pkt[1] = (ats >>> 16) & 0xff;
  pkt[2] = (ats >>> 8) & 0xff;
  pkt[3] = ats & 0xff;
  pkt[4] = 0x47;
  return pkt;
}

export function muxM2ts(units: readonly MuxUnit[]): MuxResult {
  const packets: Uint8Array[] = [];
  const counters = new Map<number, number>();
  const unitSpns: number[] = [];
  for (const unit of units) {
    unitSpns.push(packets.length);
    const pes = buildPes(unit);
    let offset = 0;
    let first = true;
    while (offset < pes.length) {
      const take = Math.min(184, pes.length - offset);
      const counter = counters.get(unit.pid) ?? 0;
      counters.set(unit.pid, (counter + 1) & 0x0f);
      const pkt = sourcePacket(packets.length);
      pkt[5] = (first ? 0x40 : 0) | ((unit.pid >> 8) & 0x1f);
      pkt[6] = unit.pid & 0xff;
      if (take < 184) {
        const afLength = 183 - take;
        pkt[7] = 0x30 | counter;
        pkt[8] = afLength;
        if (afLength > 0) {
          pkt[9] = 0x00;
          pkt.fill(0xff, 10, 9 + afLength);
        }
        pkt.set(pes.subarray(offset, offset + take), 9 + afLength);
      } else {
        pkt[7] = 0x10 | counter;
        pkt.set(pes.subarray(offset, offset + 184), 8);
      }
      packets.push(pkt);
      offset += take;
      first = false;
    }
  }
  while (packets.length % 32 !== 0) {
    const pkt = sourcePacket(packets.length);
    pkt[5] = 0x1f;
    pkt[6] = 0xff;
    pkt[7] = 0x10;
    pkt.fill(0xff, 8);
    packets.push(pkt);
  }
  const bytes = new Uint8Array(packets.length * 192);
  packets.forEach((p, i) => bytes.set(p, i * 192));
  return { bytes, unitSpns };
}
```

- [ ] **Step 2: Write the failing tests**

`src/engine/demux/ts-packet.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { muxM2ts } from '../../../tests/helpers/ts-muxer';
import { parseSourcePacket } from './ts-packet';

describe('parseSourcePacket', () => {
  const { bytes } = muxM2ts([{ pid: 0x1011, streamId: 0xe0, pts: 900_000, payload: new Uint8Array(300).fill(7) }]);

  it('parses a full-payload packet with unit start', () => {
    const p = parseSourcePacket(bytes, 0);
    expect(p).toMatchObject({ pid: 0x1011, payloadUnitStart: true, continuityCounter: 0, hasPayload: true });
    expect(p?.payload.length).toBe(184);
    expect(Array.from(p?.payload.subarray(0, 4) ?? [])).toEqual([0, 0, 1, 0xe0]);
  });

  it('skips adaptation-field stuffing', () => {
    const p = parseSourcePacket(bytes, 192);
    expect(p).toMatchObject({ pid: 0x1011, payloadUnitStart: false, continuityCounter: 1 });
    expect(p?.payload.length).toBe(314 - 184);
  });

  it('returns null for a lost sync byte or transport error', () => {
    const broken = bytes.slice(0, 192);
    broken[4] = 0x00;
    expect(parseSourcePacket(broken, 0)).toBeNull();
    const tei = bytes.slice(0, 192);
    tei[5] |= 0x80;
    expect(parseSourcePacket(tei, 0)).toBeNull();
  });

  it('reports no payload for null packets padded by the muxer', () => {
    const p = parseSourcePacket(bytes, 192 * 31);
    expect(p?.pid).toBe(0x1fff);
  });
});
```

`src/engine/demux/pes-assembler.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { muxM2ts, type MuxUnit } from '../../../tests/helpers/ts-muxer';
import { PesAssembler, type PesPacket } from './pes-assembler';
import { parseSourcePacket, type TsPacket } from './ts-packet';

function packetsOf(bytes: Uint8Array): TsPacket[] {
  const out: TsPacket[] = [];
  for (let o = 0; o < bytes.length; o += 192) {
    const p = parseSourcePacket(bytes, o);
    if (p && p.pid !== 0x1fff) out.push(p);
  }
  return out;
}

const units: MuxUnit[] = [
  { pid: 0x1011, streamId: 0xe0, pts: 903_600, dts: 900_000, payload: new Uint8Array(500).fill(1) },
  { pid: 0x1100, streamId: 0xbd, pts: 900_000, payload: new Uint8Array(40).fill(2) },
  { pid: 0x1011, streamId: 0xe0, pts: 907_200, payload: new Uint8Array(10).fill(3) },
];

describe('PesAssembler', () => {
  it('reassembles PES packets per PID with PTS and DTS', () => {
    const out: PesPacket[] = [];
    const asm = new PesAssembler((p) => out.push(p));
    for (const p of packetsOf(muxM2ts(units).bytes)) asm.push(p);
    asm.flush();
    // Video 1 completes when video 2 starts; flush() then emits per PID in first-seen order (video, audio).
    expect(out.map((p) => [p.pid, p.pts, p.dts, p.payload.length, p.payload[0]])).toEqual([
      [0x1011, 903_600, 900_000, 500, 1],
      [0x1011, 907_200, undefined, 10, 3],
      [0x1100, 900_000, undefined, 40, 2],
    ]);
  });

  it('handles timestamps above 2^32', () => {
    const out: PesPacket[] = [];
    const asm = new PesAssembler((p) => out.push(p));
    const pts = 2 ** 33 - 90_000;
    for (const p of packetsOf(muxM2ts([{ pid: 0x1011, streamId: 0xe0, pts, payload: new Uint8Array(4) }]).bytes)) asm.push(p);
    asm.flush();
    expect(out[0].pts).toBe(pts);
  });

  it('drops a PES with a continuity gap and counts it', () => {
    const out: PesPacket[] = [];
    const asm = new PesAssembler((p) => out.push(p));
    const packets = packetsOf(muxM2ts(units).bytes);
    asm.push(packets[0]);
    asm.push(packets[2]); // skip packets[1] (second packet of the first video PES)
    for (const p of packets.slice(3)) asm.push(p);
    asm.flush();
    expect(asm.continuityErrors).toBe(1);
    expect(out.map((p) => p.pts)).toEqual([907_200, 900_000]);
  });

  it('ignores a PES joined mid-way', () => {
    const out: PesPacket[] = [];
    const asm = new PesAssembler((p) => out.push(p));
    for (const p of packetsOf(muxM2ts(units).bytes).slice(1)) asm.push(p);
    asm.flush();
    expect(out.map((p) => p.pid)).toEqual([0x1100, 0x1011]);
  });
});
```

`src/engine/demux/m2ts-reader.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { muxM2ts, type MuxUnit } from '../../../tests/helpers/ts-muxer';
import { FileSource } from '../disc/file-source';
import { M2tsReader, type M2tsReaderOptions } from './m2ts-reader';
import type { PesPacket } from './pes-assembler';

const PATH = 'BDMV/STREAM/00001.M2TS';
const VIDEO = 0x1011;
const AUDIO = 0x1100;

function clip(withAudio: boolean): { source: FileSource; units: MuxUnit[]; unitSpns: number[]; bytes: Uint8Array<ArrayBuffer> } {
  const units: MuxUnit[] = [];
  for (let i = 0; i < 40; i++) {
    units.push({ pid: VIDEO, streamId: 0xe0, pts: 900_000 + i * 3750, payload: new Uint8Array(1000).fill(i) });
    if (withAudio) units.push({ pid: AUDIO, streamId: 0xbd, pts: 900_000 + i * 3750, payload: new Uint8Array(100).fill(i) });
  }
  const { bytes, unitSpns } = muxM2ts(units);
  return { source: new FileSource(new Map([[PATH, new Blob([bytes])]])), units, unitSpns, bytes };
}

async function readAll(opts: M2tsReaderOptions): Promise<PesPacket[]> {
  const reader = new M2tsReader(opts);
  const out: PesPacket[] = [];
  for (let batch = await reader.next(); batch !== null; batch = await reader.next()) out.push(...batch);
  return out;
}

describe('M2tsReader', () => {
  it('reads every selected PES across small chunks', async () => {
    const { source, units } = clip(true);
    const out = await readAll({ source, path: PATH, startSpn: 0, pids: new Set([VIDEO]), chunkPackets: 32 });
    expect(out.map((p) => p.pts)).toEqual(units.filter((u) => u.pid === VIDEO).map((u) => u.pts));
  });

  it('starts at the aligned unit containing startSpn and skips partial PES', async () => {
    const { source, units, unitSpns } = clip(false);
    const startSpn = unitSpns[20];
    const aligned = Math.floor(startSpn / 32) * 32;
    const out = await readAll({ source, path: PATH, startSpn, pids: new Set([VIDEO]), chunkPackets: 64 });
    const expected = units.filter((_, i) => unitSpns[i] >= aligned).map((u) => u.pts);
    expect(out.map((p) => p.pts)).toEqual(expected);
    expect(out.some((p) => p.pts === units[20].pts)).toBe(true);
  });

  it('stops at endSpn', async () => {
    const { source, units, unitSpns } = clip(false);
    const out = await readAll({ source, path: PATH, startSpn: 0, endSpn: unitSpns[10], pids: new Set([VIDEO]) });
    expect(out.map((p) => p.pts)).toEqual(units.slice(0, 10).map((u) => u.pts));
  });

  it('counts corrupt packets and keeps going', async () => {
    const { bytes, units } = clip(false);
    bytes[192 * 3 + 4] = 0x00; // break one packet inside the first PES
    const source = new FileSource(new Map([[PATH, new Blob([bytes])]]));
    const reader = new M2tsReader({ source, path: PATH, startSpn: 0, pids: new Set([VIDEO]) });
    const out: PesPacket[] = [];
    for (let batch = await reader.next(); batch !== null; batch = await reader.next()) out.push(...batch);
    expect(reader.stats.corruptPackets).toBe(1);
    expect(reader.stats.continuityErrors).toBe(1);
    expect(out.map((p) => p.pts)).toEqual(units.slice(1).map((u) => u.pts));
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/engine/demux`
Expected: FAIL, because `./ts-packet`, `./pes-assembler` and `./m2ts-reader` cannot be resolved.

- [ ] **Step 4: Implement `ts-packet.ts`, `pes-assembler.ts`, `m2ts-reader.ts`**

`src/engine/demux/ts-packet.ts`:
```ts
import { SOURCE_PACKET_SIZE } from './constants';

export interface TsPacket {
  readonly pid: number;
  readonly payloadUnitStart: boolean;
  readonly continuityCounter: number;
  readonly hasPayload: boolean;
  readonly payload: Uint8Array;
}

/** Parses the 192-byte source packet at `offset` (4-byte TP_extra_header + TS packet). Null if unusable. */
export function parseSourcePacket(buf: Uint8Array, offset: number): TsPacket | null {
  const o = offset + 4;
  if (buf[o] !== 0x47) return null;
  const b1 = buf[o + 1];
  const b2 = buf[o + 2];
  const b3 = buf[o + 3];
  if (b1 & 0x80) return null; // transport_error_indicator
  const adaptationFieldControl = (b3 >> 4) & 0x3;
  let payloadStart = o + 4;
  if (adaptationFieldControl & 0x2) payloadStart += 1 + buf[o + 4];
  const end = offset + SOURCE_PACKET_SIZE;
  if (payloadStart > end) return null;
  const hasPayload = (adaptationFieldControl & 0x1) !== 0 && payloadStart < end;
  return {
    pid: ((b1 & 0x1f) << 8) | b2,
    payloadUnitStart: (b1 & 0x40) !== 0,
    continuityCounter: b3 & 0x0f,
    hasPayload,
    payload: buf.subarray(hasPayload ? payloadStart : end, end),
  };
}
```

`src/engine/demux/pes-assembler.ts`:
```ts
import type { TsPacket } from './ts-packet';

export interface PesPacket {
  readonly pid: number;
  readonly streamId: number;
  /** 90 kHz. */
  readonly pts?: number;
  readonly dts?: number;
  readonly payload: Uint8Array;
}

interface PidState {
  chunks: Uint8Array[];
  size: number;
  lastCc: number;
  broken: boolean;
}

/** Stream ids whose PES packets carry no optional header (ISO 13818-1 Table 2-21). */
const NO_HEADER_STREAM_IDS = new Set([0xbc, 0xbe, 0xbf, 0xf0, 0xf1, 0xf2, 0xf8, 0xff]);

export function readTimestamp(d: Uint8Array, o: number): number {
  return ((d[o] >> 1) & 0x07) * 0x40000000 + ((d[o + 1] << 22) | ((d[o + 2] >> 1) << 15) | (d[o + 3] << 7) | (d[o + 4] >> 1));
}

/** Reassembles PES packets per PID. A PES completes at the next unit start on its PID, or on flush(). */
export class PesAssembler {
  continuityErrors = 0;
  private readonly states = new Map<number, PidState>();

  constructor(private readonly onPes: (pes: PesPacket) => void) {}

  push(packet: TsPacket): void {
    if (!packet.hasPayload) return; // CC does not advance on adaptation-only packets
    const state = this.states.get(packet.pid);
    if (packet.payloadUnitStart) {
      if (state) this.emit(packet.pid, state);
      this.states.set(packet.pid, { chunks: [packet.payload], size: packet.payload.length, lastCc: packet.continuityCounter, broken: false });
      return;
    }
    if (!state) return; // joined mid-PES (after a seek); wait for the next unit start
    if (packet.continuityCounter === state.lastCc) return; // duplicate packet
    if (packet.continuityCounter !== ((state.lastCc + 1) & 0x0f)) {
      state.broken = true;
      this.continuityErrors++;
    }
    state.lastCc = packet.continuityCounter;
    state.chunks.push(packet.payload);
    state.size += packet.payload.length;
  }

  flush(): void {
    for (const [pid, state] of this.states) this.emit(pid, state);
    this.states.clear();
  }

  reset(): void {
    this.states.clear();
  }

  private emit(pid: number, state: PidState): void {
    if (state.broken) return;
    const data = new Uint8Array(state.size);
    let at = 0;
    for (const chunk of state.chunks) {
      data.set(chunk, at);
      at += chunk.length;
    }
    const pes = parsePes(pid, data);
    if (pes) this.onPes(pes);
  }
}

function parsePes(pid: number, d: Uint8Array): PesPacket | null {
  if (d.length < 6 || d[0] !== 0 || d[1] !== 0 || d[2] !== 1) return null;
  const streamId = d[3];
  const declared = (d[4] << 8) | d[5];
  const end = declared === 0 ? d.length : Math.min(d.length, 6 + declared);
  if (NO_HEADER_STREAM_IDS.has(streamId)) return { pid, streamId, payload: d.subarray(6, end) };
  if (d.length < 9) return null;
  const ptsDtsFlags = d[7] >> 6;
  const headerEnd = 9 + d[8];
  if (headerEnd > end) return null;
  return {
    pid,
    streamId,
    pts: ptsDtsFlags & 0x2 ? readTimestamp(d, 9) : undefined,
    dts: ptsDtsFlags === 0x3 ? readTimestamp(d, 14) : undefined,
    payload: d.subarray(headerEnd, end),
  };
}
```

`src/engine/demux/m2ts-reader.ts`:
```ts
import type { ByteSource } from '../disc/byte-source';
import { PACKETS_PER_ALIGNED_UNIT, SOURCE_PACKET_SIZE } from './constants';
import { PesAssembler, type PesPacket } from './pes-assembler';
import { parseSourcePacket } from './ts-packet';

export interface M2tsReaderOptions {
  readonly source: ByteSource;
  readonly path: string;
  /** Rounded down to an aligned unit. */
  readonly startSpn: number;
  /** Exclusive; defaults to end of file. */
  readonly endSpn?: number;
  readonly pids: ReadonlySet<number>;
  /** Packets per read; rounded to whole aligned units. Default ≈ 2 MB. */
  readonly chunkPackets?: number;
}

export interface DemuxStats {
  readonly corruptPackets: number;
  readonly continuityErrors: number;
}

export const DEFAULT_CHUNK_PACKETS = PACKETS_PER_ALIGNED_UNIT * 341;

/** Reads a clip in aligned chunks, prefetching the next chunk while the current one is demuxed. */
export class M2tsReader {
  private readonly assembler: PesAssembler;
  private readonly out: PesPacket[] = [];
  private readonly endSpn: number;
  private readonly chunkPackets: number;
  private cursor: number;
  private prefetch: Promise<Uint8Array> | null = null;
  private done = false;
  private corruptPackets = 0;

  constructor(private readonly opts: M2tsReaderOptions) {
    this.assembler = new PesAssembler((pes) => this.out.push(pes));
    const total = Math.floor(opts.source.size(opts.path) / SOURCE_PACKET_SIZE);
    this.endSpn = Math.min(opts.endSpn ?? total, total);
    const requested = opts.chunkPackets ?? DEFAULT_CHUNK_PACKETS;
    this.chunkPackets = Math.max(1, Math.round(requested / PACKETS_PER_ALIGNED_UNIT)) * PACKETS_PER_ALIGNED_UNIT;
    this.cursor = Math.floor(opts.startSpn / PACKETS_PER_ALIGNED_UNIT) * PACKETS_PER_ALIGNED_UNIT;
  }

  get stats(): DemuxStats {
    return { corruptPackets: this.corruptPackets, continuityErrors: this.assembler.continuityErrors };
  }

  /** PES packets completed by the next chunk (possibly empty), or null once the range is exhausted. */
  async next(): Promise<PesPacket[] | null> {
    if (this.done) return null;
    if (this.cursor >= this.endSpn) {
      this.done = true;
      this.assembler.flush();
      return this.out.splice(0);
    }
    const chunkStart = this.cursor;
    const count = Math.min(this.chunkPackets, this.endSpn - chunkStart);
    const data = await (this.prefetch ?? this.readPackets(chunkStart, count));
    this.cursor = chunkStart + count;
    this.prefetch = this.cursor < this.endSpn ? this.readPackets(this.cursor, Math.min(this.chunkPackets, this.endSpn - this.cursor)) : null;

    const packets = Math.floor(data.length / SOURCE_PACKET_SIZE);
    for (let k = 0; k < packets; k++) {
      const packet = parseSourcePacket(data, k * SOURCE_PACKET_SIZE);
      if (!packet) {
        this.corruptPackets++;
        continue;
      }
      if (this.opts.pids.has(packet.pid)) this.assembler.push(packet);
    }
    return this.out.splice(0);
  }

  private readPackets(spn: number, count: number): Promise<Uint8Array> {
    const read = this.opts.source.read(this.opts.path, spn * SOURCE_PACKET_SIZE, count * SOURCE_PACKET_SIZE);
    read.catch(() => undefined); // an abandoned prefetch must not surface as an unhandled rejection
    return read;
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/engine/demux && npm run typecheck`
Expected: all pass. In the corrupt-packet test, the broken packet makes the next packet look like a continuity gap, so the first PES is dropped, and both counters read 1.

- [ ] **Step 6: Commit**

```bash
git add src/engine/demux tests/helpers/ts-muxer.ts
git commit -m "feat(engine): demux M2TS source packets into PES with chunked prefetching reader"
```

---

### Task 9: NAL parsing, H.264 and HEVC access-unit analysis

**Files:**
- Create: `src/engine/decode/nal.ts`, `src/engine/decode/h264.ts`, `src/engine/decode/hevc.ts`, `tests/helpers/h264-units.ts`
- Test: `src/engine/decode/nal.test.ts`, `src/engine/decode/h264.test.ts`, `src/engine/decode/hevc.test.ts`

**Interfaces:**
- Produces:
  - `splitAnnexB(data): Uint8Array[]` (NAL units without start codes); `unescapeRbsp(nal)`; `joinAnnexB(nals)` (with 4-byte start codes)
  - `interface AccessUnitInfo { key; idr; sps: Uint8Array | null; data: Uint8Array /* MVC NALs removed for AVC */ }`
  - `analyzeAvc(data)`, `avcCodecString(sps)` (for example `avc1.640028`)
  - `analyzeHevc(data)`, `hevcCodecString(sps)` (for example `hev1.1.6.L93.90`)
  - Test helper: `TEST_SPS`, and `avcAu({ idr?, recovery?, sps?, mvc?, fill? }): Uint8Array<ArrayBuffer>`

Key-frame policy: an AVC access unit is a **key** if it has an IDR slice (NAL 5) or a recovery-point SEI (payload type 6). Blu-ray encoders often use open-GOP I-frames marked only by a recovery point. HEVC IRAP pictures (NAL 16–21) are keys, and NAL 19/20 are IDR. The decoder wrapper (Task 10) falls back to requiring IDR if a non-IDR key fails.

- [ ] **Step 1: Write the H.264 test-unit helper**

`tests/helpers/h264-units.ts`:
```ts
/** High profile, level 4.0 SPS header bytes (enough for codec-string derivation). */
export const TEST_SPS = new Uint8Array([0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0x40]);
const TEST_PPS = [0x68, 0xeb, 0xe3, 0xcb];
const AUD = [0x09, 0xf0];
const RECOVERY_SEI = [0x06, 0x06, 0x01, 0x84, 0x80];
const IDR_SLICE = [0x65, 0x88, 0x84, 0x00, 0x33];
const NON_IDR_SLICE = [0x41, 0x9a, 0x02, 0x11];
const MVC_PREFIX = [0x0e, 0x01, 0x02];
const MVC_SLICE = [0x14, 0x01, 0x02, 0x03];

export interface AvcAuOptions {
  idr?: boolean;
  recovery?: boolean;
  sps?: boolean;
  mvc?: boolean;
  /** Extra slice payload bytes, to make units larger than one TS packet. */
  fill?: number;
}

export function avcAu(opts: AvcAuOptions = {}): Uint8Array<ArrayBuffer> {
  const nals: number[][] = [AUD];
  if (opts.sps ?? opts.idr) nals.push(Array.from(TEST_SPS), TEST_PPS);
  if (opts.recovery) nals.push(RECOVERY_SEI);
  if (opts.mvc) nals.push(MVC_PREFIX);
  nals.push([...(opts.idr ? IDR_SLICE : NON_IDR_SLICE), ...new Array<number>(opts.fill ?? 0).fill(0x55)]);
  if (opts.mvc) nals.push(MVC_SLICE);
  const bytes: number[] = [];
  for (const nal of nals) bytes.push(0, 0, 0, 1, ...nal);
  return new Uint8Array(bytes);
}
```

- [ ] **Step 2: Write the failing tests**

`src/engine/decode/nal.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { joinAnnexB, splitAnnexB, unescapeRbsp } from './nal';

describe('NAL helpers', () => {
  it('splits 3- and 4-byte start codes and trims trailing zeros', () => {
    const data = new Uint8Array([0, 0, 0, 1, 0x09, 0xf0, 0, 0, 1, 0x67, 0x64, 0x00, 0, 0, 0, 1, 0x65, 0x88]);
    expect(splitAnnexB(data).map((n) => Array.from(n))).toEqual([[0x09, 0xf0], [0x67, 0x64], [0x65, 0x88]]);
  });

  it('removes emulation prevention bytes', () => {
    expect(Array.from(unescapeRbsp(new Uint8Array([1, 0, 0, 3, 0, 0, 0, 3, 1, 0, 0, 3])))).toEqual([1, 0, 0, 0, 0, 0, 1, 0, 0]);
  });

  it('joins NAL units with 4-byte start codes', () => {
    const joined = joinAnnexB([new Uint8Array([0x09, 0xf0]), new Uint8Array([0x65])]);
    expect(Array.from(joined)).toEqual([0, 0, 0, 1, 0x09, 0xf0, 0, 0, 0, 1, 0x65]);
    expect(splitAnnexB(joined).length).toBe(2);
  });
});
```

`src/engine/decode/h264.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { TEST_SPS, avcAu } from '../../../tests/helpers/h264-units';
import { analyzeAvc, avcCodecString } from './h264';
import { splitAnnexB } from './nal';

describe('H.264 analysis', () => {
  it('derives the codec string from the SPS', () => {
    expect(avcCodecString(TEST_SPS)).toBe('avc1.640028');
  });

  it('marks IDR access units as key and returns the SPS', () => {
    const info = analyzeAvc(avcAu({ idr: true }));
    expect(info.key).toBe(true);
    expect(info.idr).toBe(true);
    expect(Array.from(info.sps ?? [])).toEqual(Array.from(TEST_SPS));
  });

  it('marks recovery-point I-frames as key but not IDR', () => {
    const info = analyzeAvc(avcAu({ recovery: true, sps: true }));
    expect(info.key).toBe(true);
    expect(info.idr).toBe(false);
  });

  it('marks plain slices as non-key', () => {
    const info = analyzeAvc(avcAu());
    expect(info.key).toBe(false);
    expect(info.sps).toBeNull();
  });

  it('strips MVC NAL units (types 14, 15, 20)', () => {
    const info = analyzeAvc(avcAu({ idr: true, mvc: true }));
    const types = splitAnnexB(info.data).map((n) => n[0] & 0x1f);
    expect(types).toEqual([9, 7, 8, 5]);
  });

  it('returns the original buffer when there is nothing to strip', () => {
    const au = avcAu({ idr: true });
    expect(analyzeAvc(au).data).toBe(au);
  });
});
```

`src/engine/decode/hevc.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { analyzeHevc, hevcCodecString } from './hevc';

// Escaped SPS prefixes (emulation-prevention bytes included, as on disc).
const MAIN_SPS = new Uint8Array([0x42, 0x01, 0x01, 0x01, 0x60, 0x00, 0x00, 0x03, 0x00, 0x90, 0x00, 0x00, 0x03, 0x00, 0x00, 0x03, 0x00, 0x5d]);
const MAIN10_SPS = new Uint8Array([0x42, 0x01, 0x01, 0x02, 0x20, 0x00, 0x00, 0x03, 0x00, 0x90, 0x00, 0x00, 0x03, 0x00, 0x00, 0x03, 0x00, 0x78]);

function au(...nals: number[][]): Uint8Array {
  return new Uint8Array(nals.flatMap((n) => [0, 0, 0, 1, ...n]));
}

describe('HEVC analysis', () => {
  it('derives codec strings from escaped SPS bytes', () => {
    expect(hevcCodecString(MAIN_SPS)).toBe('hev1.1.6.L93.90');
    expect(hevcCodecString(MAIN10_SPS)).toBe('hev1.2.4.L120.90');
  });

  it('classifies IRAP pictures', () => {
    const idr = analyzeHevc(au([0x46, 0x01, 0x10], Array.from(MAIN_SPS), [0x26, 0x01, 0xaf]));
    expect(idr).toMatchObject({ key: true, idr: true });
    expect(idr.sps?.[0]).toBe(0x42);
    expect(analyzeHevc(au([0x2a, 0x01, 0xaf]))).toMatchObject({ key: true, idr: false });
    expect(analyzeHevc(au([0x02, 0x01, 0xd0]))).toMatchObject({ key: false, idr: false, sps: null });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/engine/decode`
Expected: FAIL, because `./nal`, `./h264` and `./hevc` cannot be resolved.

- [ ] **Step 4: Implement `nal.ts`, `h264.ts`, `hevc.ts`**

`src/engine/decode/nal.ts`:
```ts
/** Splits an Annex-B byte stream into NAL units (start codes removed, trailing zero bytes trimmed). */
export function splitAnnexB(data: Uint8Array): Uint8Array[] {
  const nals: Uint8Array[] = [];
  let start = -1;
  let i = 0;
  while (i + 2 < data.length) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if (start >= 0) nals.push(trimTrailingZeros(data.subarray(start, i)));
      i += 3;
      start = i;
    } else {
      i++;
    }
  }
  if (start >= 0 && start < data.length) nals.push(trimTrailingZeros(data.subarray(start)));
  return nals.filter((n) => n.length > 0);
}

function trimTrailingZeros(nal: Uint8Array): Uint8Array {
  let end = nal.length;
  while (end > 0 && nal[end - 1] === 0) end--;
  return nal.subarray(0, end);
}

/** Removes emulation-prevention bytes (0x03 following two zero bytes). */
export function unescapeRbsp(nal: Uint8Array): Uint8Array {
  const out = new Uint8Array(nal.length);
  let n = 0;
  let zeros = 0;
  for (const b of nal) {
    if (zeros >= 2 && b === 0x03) {
      zeros = 0;
      continue;
    }
    out[n++] = b;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, n);
}

export function joinAnnexB(nals: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(nals.reduce((sum, n) => sum + 4 + n.length, 0));
  let at = 0;
  for (const nal of nals) {
    out.set([0, 0, 0, 1], at);
    out.set(nal, at + 4);
    at += 4 + nal.length;
  }
  return out;
}
```

`src/engine/decode/h264.ts`:
```ts
import { joinAnnexB, splitAnnexB, unescapeRbsp } from './nal';

export interface AccessUnitInfo {
  readonly key: boolean;
  readonly idr: boolean;
  readonly sps: Uint8Array | null;
  /** The access unit to decode (MVC NAL units removed for AVC). */
  readonly data: Uint8Array;
}

const NAL_IDR = 5;
const NAL_SEI = 6;
const NAL_SPS = 7;
/** Prefix NAL, subset SPS, coded slice extension: MVC dependent-view data that a 2D decoder must not see. */
const MVC_TYPES = new Set([14, 15, 20]);
const SEI_RECOVERY_POINT = 6;

export function avcCodecString(sps: Uint8Array): string {
  const hex = (b: number): string => b.toString(16).padStart(2, '0');
  return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;
}

export function analyzeAvc(data: Uint8Array): AccessUnitInfo {
  const nals = splitAnnexB(data);
  let idr = false;
  let recovery = false;
  let sps: Uint8Array | null = null;
  let hasMvc = false;
  for (const nal of nals) {
    const type = nal[0] & 0x1f;
    if (MVC_TYPES.has(type)) {
      hasMvc = true;
    } else if (type === NAL_IDR) {
      idr = true;
    } else if (type === NAL_SPS) {
      sps ??= nal;
    } else if (type === NAL_SEI && seiHasRecoveryPoint(nal)) {
      recovery = true;
    }
  }
  const out = hasMvc ? joinAnnexB(nals.filter((n) => !MVC_TYPES.has(n[0] & 0x1f))) : data;
  return { key: idr || recovery, idr, sps, data: out };
}

function seiHasRecoveryPoint(nal: Uint8Array): boolean {
  const rbsp = unescapeRbsp(nal.subarray(1));
  let i = 0;
  while (i < rbsp.length && rbsp[i] !== 0x80) {
    let type = 0;
    while (rbsp[i] === 0xff) {
      type += 255;
      i++;
    }
    type += rbsp[i++];
    let size = 0;
    while (rbsp[i] === 0xff) {
      size += 255;
      i++;
    }
    size += rbsp[i++];
    if (type === SEI_RECOVERY_POINT) return true;
    i += size;
  }
  return false;
}
```

`src/engine/decode/hevc.ts`:
```ts
import type { AccessUnitInfo } from './h264';
import { splitAnnexB, unescapeRbsp } from './nal';

const NAL_SPS = 33;
const IRAP_FIRST = 16;
const IRAP_LAST = 21;
const IDR_W_RADL = 19;
const IDR_N_LP = 20;

function nalType(nal: Uint8Array): number {
  return (nal[0] >> 1) & 0x3f;
}

function reverseBits32(x: number): number {
  let v = x >>> 0;
  let r = 0;
  for (let i = 0; i < 32; i++) {
    r = (r << 1) | (v & 1);
    v >>>= 1;
  }
  return r >>> 0;
}

/** ISO/IEC 14496-15 Annex E codec string from the SPS profile_tier_level. */
export function hevcCodecString(sps: Uint8Array): string {
  const r = unescapeRbsp(sps);
  const profileSpace = r[3] >> 6;
  const tier = (r[3] >> 5) & 1;
  const profile = r[3] & 0x1f;
  const compat = ((r[4] << 24) | (r[5] << 16) | (r[6] << 8) | r[7]) >>> 0;
  const constraints = r.subarray(8, 14);
  const level = r[14];
  let s = `hev1.${['', 'A', 'B', 'C'][profileSpace]}${profile}.${reverseBits32(compat).toString(16).toUpperCase()}.${tier ? 'H' : 'L'}${level}`;
  let last = constraints.length - 1;
  while (last >= 0 && constraints[last] === 0) last--;
  for (let i = 0; i <= last; i++) s += `.${constraints[i].toString(16).toUpperCase()}`;
  return s;
}

export function analyzeHevc(data: Uint8Array): AccessUnitInfo {
  let key = false;
  let idr = false;
  let sps: Uint8Array | null = null;
  for (const nal of splitAnnexB(data)) {
    const type = nalType(nal);
    if (type >= IRAP_FIRST && type <= IRAP_LAST) key = true;
    if (type === IDR_W_RADL || type === IDR_N_LP) idr = true;
    if (type === NAL_SPS) sps ??= nal;
  }
  return { key, idr, sps, data };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/engine/decode && npm run typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/engine/decode tests/helpers/h264-units.ts
git commit -m "feat(engine): analyze H.264/HEVC access units and derive WebCodecs codec strings"
```

---

### Task 10: Decoder interface and WebCodecs video decoder wrapper

**Files:**
- Create: `src/engine/decode/decoder.ts`, `src/engine/decode/video-decoder.ts`
- Test: `src/engine/decode/video-decoder.test.ts`

**Interfaces:**
- Consumes: `CodingType`, `codingName` (Task 3); `analyzeAvc`, `avcCodecString`, `analyzeHevc`, `hevcCodecString` (Task 9).
- Produces:
  - `interface StreamConfig { codingType; firstUnit? }`
  - `interface Decoder<In, Out> { configure; decode; flush; reset; close; onOutput; onError; queueSize }`
  - `class UnsupportedCodecError extends Error { codingType }`; `class DecoderError extends Error { fatal }`
  - `interface VideoUnit { data; ptsUs; discard }`
  - `interface VideoDecoderLike`, `interface VideoCodecApi { create; isConfigSupported; makeChunk }`, `browserVideoCodecApi`
  - `hasSps(codingType, data): boolean`
  - `class WebCodecsVideoDecoder implements Decoder<VideoUnit, VideoFrame>` (constructor takes an optional `VideoCodecApi`), plus a `codec: string | null` getter.

Behavior:
- `configure` derives the codec string from the first unit's SPS, checks `isConfigSupported`, and throws `UnsupportedCodecError` for codecs it cannot handle.
- `decode` drops units until a key unit arrives, and requires an IDR if a previous non-IDR start failed. Units with `discard` are decoded but their frames are closed instead of output.
- On a decoder error, the wrapper reopens and waits for the next key. More than 3 consecutive errors without an output frame raise a fatal `DecoderError`.
- `reset` drops pending work and requires a key again.

- [ ] **Step 1: Create `src/engine/decode/decoder.ts`**

```ts
export interface StreamConfig {
  readonly codingType: number;
  /** First access unit of the stream; video uses its SPS to build the codec string. */
  readonly firstUnit?: Uint8Array;
}

/** Common shape of every decoder (WebCodecs now; WASM fallbacks in later milestones). */
export interface Decoder<In, Out> {
  configure(config: StreamConfig): Promise<void>;
  decode(unit: In): void;
  flush(): Promise<void>;
  /** Drops queued work; the next decoded unit must be a key unit. Configuration is kept. */
  reset(): void;
  close(): void;
  onOutput: (out: Out) => void;
  onError: (err: DecoderError) => void;
  readonly queueSize: number;
}

export class UnsupportedCodecError extends Error {
  constructor(
    readonly codingType: number,
    message: string,
  ) {
    super(message);
    this.name = 'UnsupportedCodecError';
  }
}

export class DecoderError extends Error {
  constructor(
    message: string,
    readonly fatal: boolean,
  ) {
    super(message);
    this.name = 'DecoderError';
  }
}
```

- [ ] **Step 2: Write the failing tests**

`src/engine/decode/video-decoder.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { avcAu } from '../../../tests/helpers/h264-units';
import { CodingType } from '../bdmv/stream-types';
import { DecoderError, UnsupportedCodecError } from './decoder';
import { WebCodecsVideoDecoder, type VideoCodecApi, type VideoDecoderLike } from './video-decoder';

interface FakeFrame {
  timestamp: number;
  closed: boolean;
  close(): void;
}

class FakeDecoder implements VideoDecoderLike {
  state: CodecState = 'unconfigured';
  decodeQueueSize = 0;
  config: VideoDecoderConfig | null = null;
  readonly chunks: EncodedVideoChunkInit[] = [];
  readonly frames: FakeFrame[] = [];

  constructor(private readonly init: VideoDecoderInit) {}

  configure(config: VideoDecoderConfig): void {
    this.config = config;
    this.state = 'configured';
  }

  decode(chunk: EncodedVideoChunk): void {
    const init = chunk as unknown as EncodedVideoChunkInit;
    this.chunks.push(init);
    const frame: FakeFrame = { timestamp: init.timestamp, closed: false, close() { this.closed = true; } };
    this.frames.push(frame);
    this.init.output(frame as unknown as VideoFrame);
  }

  async flush(): Promise<void> {}

  reset(): void {
    this.state = 'unconfigured';
  }

  close(): void {
    this.state = 'closed';
  }

  fail(message: string): void {
    this.state = 'closed';
    this.init.error(new DOMException(message, 'EncodingError'));
  }
}

function setup(supported = true): { api: VideoCodecApi; created: FakeDecoder[]; checked: VideoDecoderConfig[] } {
  const created: FakeDecoder[] = [];
  const checked: VideoDecoderConfig[] = [];
  const api: VideoCodecApi = {
    create: (init) => {
      const d = new FakeDecoder(init);
      created.push(d);
      return d;
    },
    isConfigSupported: async (config) => {
      checked.push(config);
      return { supported, config };
    },
    makeChunk: (init) => init as unknown as EncodedVideoChunk,
  };
  return { api, created, checked };
}

async function configured(): Promise<{ dec: WebCodecsVideoDecoder; created: FakeDecoder[]; out: VideoFrame[]; errors: DecoderError[] }> {
  const { api, created } = setup();
  const dec = new WebCodecsVideoDecoder(api);
  const out: VideoFrame[] = [];
  const errors: DecoderError[] = [];
  dec.onOutput = (f) => out.push(f);
  dec.onError = (e) => errors.push(e);
  await dec.configure({ codingType: CodingType.AVC, firstUnit: avcAu({ idr: true }) });
  return { dec, created, out, errors };
}

describe('WebCodecsVideoDecoder', () => {
  it('configures AVC with a codec string from the SPS', async () => {
    const { api, created, checked } = setup();
    const dec = new WebCodecsVideoDecoder(api);
    await dec.configure({ codingType: CodingType.AVC, firstUnit: avcAu({ idr: true }) });
    expect(checked).toEqual([{ codec: 'avc1.640028' }]);
    expect(created[0].config?.codec).toBe('avc1.640028');
    expect(dec.codec).toBe('avc1.640028');
  });

  it('rejects unsupported codecs', async () => {
    const { api } = setup();
    await expect(new WebCodecsVideoDecoder(api).configure({ codingType: CodingType.VC1, firstUnit: avcAu({ idr: true }) })).rejects.toBeInstanceOf(UnsupportedCodecError);
    const unsupported = setup(false);
    await expect(new WebCodecsVideoDecoder(unsupported.api).configure({ codingType: CodingType.AVC, firstUnit: avcAu({ idr: true }) })).rejects.toBeInstanceOf(UnsupportedCodecError);
  });

  it('skips delta units until a key unit, then marks only the first as key', async () => {
    const { dec, created, out } = await configured();
    dec.decode({ data: avcAu(), ptsUs: 0, discard: false });
    dec.decode({ data: avcAu({ idr: true }), ptsUs: 41_708, discard: false });
    dec.decode({ data: avcAu(), ptsUs: 83_416, discard: false });
    expect(created[0].chunks.map((c) => [c.type, c.timestamp])).toEqual([
      ['key', 41_708],
      ['delta', 83_416],
    ]);
    expect(out.map((f) => f.timestamp)).toEqual([41_708, 83_416]);
  });

  it('closes frames of discarded units instead of outputting them', async () => {
    const { dec, created, out } = await configured();
    dec.decode({ data: avcAu({ idr: true }), ptsUs: 0, discard: true });
    dec.decode({ data: avcAu(), ptsUs: 41_708, discard: false });
    expect(out.map((f) => f.timestamp)).toEqual([41_708]);
    expect(created[0].frames[0].closed).toBe(true);
  });

  it('after an error following a recovery-point start, waits for an IDR', async () => {
    const { dec, created, errors } = await configured();
    dec.decode({ data: avcAu({ recovery: true, sps: true }), ptsUs: 0, discard: false });
    created[0].fail('bad keyframe');
    expect(errors.map((e) => e.fatal)).toEqual([false]);
    expect(created).toHaveLength(2);
    dec.decode({ data: avcAu({ recovery: true, sps: true }), ptsUs: 41_708, discard: false });
    expect(created[1].chunks).toHaveLength(0);
    dec.decode({ data: avcAu({ idr: true }), ptsUs: 83_416, discard: false });
    expect(created[1].chunks.map((c) => c.type)).toEqual(['key']);
  });

  it('gives up with a fatal error after repeated failures without output', async () => {
    const { dec, created, errors } = await configured();
    for (let i = 0; i < 4; i++) created[created.length - 1].fail(`boom ${i}`);
    expect(errors.map((e) => e.fatal)).toEqual([false, false, false, true]);
    dec.decode({ data: avcAu({ idr: true }), ptsUs: 0, discard: false }); // no-op once fatal
  });

  it('reset requires a key unit again and forgets discards', async () => {
    const { dec, created, out } = await configured();
    dec.decode({ data: avcAu({ idr: true }), ptsUs: 0, discard: false });
    dec.reset();
    expect(created[0].state).toBe('configured');
    dec.decode({ data: avcAu(), ptsUs: 41_708, discard: false });
    dec.decode({ data: avcAu({ idr: true }), ptsUs: 83_416, discard: false });
    expect(out.map((f) => f.timestamp)).toEqual([0, 83_416]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/engine/decode/video-decoder.test.ts`
Expected: FAIL, because `./video-decoder` cannot be resolved.

- [ ] **Step 4: Implement `src/engine/decode/video-decoder.ts`**

```ts
import { CodingType, codingName } from '../bdmv/stream-types';
import { DecoderError, UnsupportedCodecError, type Decoder, type StreamConfig } from './decoder';
import { analyzeAvc, avcCodecString, type AccessUnitInfo } from './h264';
import { analyzeHevc, hevcCodecString } from './hevc';

export interface VideoUnit {
  readonly data: Uint8Array;
  readonly ptsUs: number;
  /** Decode for reference but never present (e.g. before a seek target or outside the play item). */
  readonly discard: boolean;
}

export interface VideoDecoderLike {
  readonly state: CodecState;
  readonly decodeQueueSize: number;
  configure(config: VideoDecoderConfig): void;
  decode(chunk: EncodedVideoChunk): void;
  flush(): Promise<void>;
  reset(): void;
  close(): void;
}

export interface VideoCodecApi {
  create(init: VideoDecoderInit): VideoDecoderLike;
  isConfigSupported(config: VideoDecoderConfig): Promise<VideoDecoderSupport>;
  makeChunk(init: EncodedVideoChunkInit): EncodedVideoChunk;
}

export const browserVideoCodecApi: VideoCodecApi = {
  create: (init) => new VideoDecoder(init),
  isConfigSupported: (config) => VideoDecoder.isConfigSupported(config),
  makeChunk: (init) => new EncodedVideoChunk(init),
};

interface CodecOps {
  analyze(data: Uint8Array): AccessUnitInfo;
  codecString(sps: Uint8Array): string;
}

const CODECS: ReadonlyMap<number, CodecOps> = new Map<number, CodecOps>([
  [CodingType.AVC, { analyze: analyzeAvc, codecString: avcCodecString }],
  [CodingType.HEVC, { analyze: analyzeHevc, codecString: hevcCodecString }],
]);

const MAX_CONSECUTIVE_ERRORS = 3;

export function hasSps(codingType: number, data: Uint8Array): boolean {
  return (CODECS.get(codingType)?.analyze(data).sps ?? null) !== null;
}

export class WebCodecsVideoDecoder implements Decoder<VideoUnit, VideoFrame> {
  onOutput: (frame: VideoFrame) => void = () => undefined;
  onError: (err: DecoderError) => void = () => undefined;

  private decoder: VideoDecoderLike | null = null;
  private config: VideoDecoderConfig | null = null;
  private ops: CodecOps | null = null;
  private needKey = true;
  private requireIdr = false;
  private lastKeyWasIdr = true;
  private consecutiveErrors = 0;
  private readonly discard = new Set<number>();

  constructor(private readonly api: VideoCodecApi = browserVideoCodecApi) {}

  get queueSize(): number {
    return this.decoder?.decodeQueueSize ?? 0;
  }

  get codec(): string | null {
    return this.config?.codec ?? null;
  }

  async configure(config: StreamConfig): Promise<void> {
    const ops = CODECS.get(config.codingType);
    if (!ops) throw new UnsupportedCodecError(config.codingType, `${codingName(config.codingType)} video is not supported.`);
    if (!config.firstUnit) throw new Error('video configure() needs the first access unit');
    const info = ops.analyze(config.firstUnit);
    if (!info.sps) throw new Error('first video access unit has no SPS');
    const vdc: VideoDecoderConfig = { codec: ops.codecString(info.sps) };
    const support = await this.api.isConfigSupported(vdc);
    if (!support.supported) {
      throw new UnsupportedCodecError(config.codingType, `This browser cannot decode ${codingName(config.codingType)} (${vdc.codec}).`);
    }
    this.ops = ops;
    this.config = vdc;
    this.open();
  }

  decode(unit: VideoUnit): void {
    const decoder = this.decoder;
    const ops = this.ops;
    if (!decoder || !ops || decoder.state !== 'configured') return;
    const info = ops.analyze(unit.data);
    const startsSequence = this.needKey;
    if (startsSequence) {
      if (!info.key || (this.requireIdr && !info.idr)) return;
      this.needKey = false;
      this.lastKeyWasIdr = info.idr;
    }
    if (unit.discard) this.discard.add(unit.ptsUs);
    decoder.decode(this.api.makeChunk({ type: startsSequence || info.idr ? 'key' : 'delta', timestamp: unit.ptsUs, data: info.data }));
  }

  async flush(): Promise<void> {
    const decoder = this.decoder;
    if (!decoder || decoder.state !== 'configured') return;
    try {
      await decoder.flush();
    } catch {
      return; // a reset() during flush aborts it; nothing to do
    }
    this.needKey = true;
  }

  reset(): void {
    this.discard.clear();
    this.needKey = true;
    const decoder = this.decoder;
    if (!decoder || !this.config) return;
    if (decoder.state === 'closed') {
      this.open();
      return;
    }
    decoder.reset();
    decoder.configure(this.config);
  }

  close(): void {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = null;
    this.discard.clear();
  }

  private open(): void {
    const config = this.config;
    if (!config) return;
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    const decoder = this.api.create({
      output: (frame) => this.handleFrame(decoder, frame),
      error: (err) => this.handleError(decoder, err),
    });
    decoder.configure(config);
    this.decoder = decoder;
    this.needKey = true;
    this.discard.clear();
  }

  private handleFrame(source: VideoDecoderLike, frame: VideoFrame): void {
    if (source !== this.decoder) {
      frame.close();
      return;
    }
    this.consecutiveErrors = 0;
    if (this.discard.delete(frame.timestamp)) {
      frame.close();
      return;
    }
    this.onOutput(frame);
  }

  private handleError(source: VideoDecoderLike, err: DOMException): void {
    if (source !== this.decoder) return;
    this.consecutiveErrors++;
    if (!this.lastKeyWasIdr) this.requireIdr = true;
    if (this.consecutiveErrors > MAX_CONSECUTIVE_ERRORS) {
      this.decoder = null;
      this.onError(new DecoderError(`Video decoding failed: ${err.message}`, true));
      return;
    }
    this.open();
    this.onError(new DecoderError(`Video decoder error, recovering at the next keyframe: ${err.message}`, false));
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/engine/decode && npm run typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/engine/decode
git commit -m "feat(engine): wrap WebCodecs VideoDecoder with key-frame gating and error recovery"
```

---

### Task 11: Blu-ray LPCM decoding and decimation to 48 kHz

**Files:**
- Create: `src/engine/decode/lpcm.ts`, `src/engine/decode/decimator.ts`
- Test: `src/engine/decode/lpcm.test.ts`, `src/engine/decode/decimator.test.ts`

**Interfaces:**
- Consumes: `UnsupportedCodecError` (Task 10), `CodingType`.
- Produces:
  - `interface LpcmHeader { channelAssignment; sampleRate; bitsPerSample: 16 | 24; codedChannels; storedChannels }`
  - `interface PcmChunk { ptsUs; sampleRate; frames; stereo: Float32Array /* interleaved L,R */ }`
  - `parseLpcmHeader(payload)`; `decodeLpcm(payload, ptsUs): PcmChunk` (downmixed to stereo)
  - `class Decimator(factor)` with `process(chunk): PcmChunk` and `reset()`

LPCM format (Blu-ray Part 3, FFmpeg `pcm-bluray.c`):
- The 4-byte header is `payload_size:16`, `channel_assignment:4`, `sampling_frequency:4`, `bits_per_sample:2`, `reserved:6`. Sampling-frequency codes: 1 = 48 kHz, 4 = 96 kHz, 5 = 192 kHz. Bits-per-sample codes: 1 = 16, 2 = 20 (unsupported), 3 = 24.
- Samples are big-endian and interleaved, and the stored channel count is padded to an even number.
- Coded channel orders:

| Assignment | Coded order |
|---|---|
| 1 | C |
| 3 | L R |
| 4 | L R C |
| 5 | L R S |
| 6 | L R C S |
| 7 | L R Ls Rs |
| 8 | L R C Ls Rs |
| 9 | L R C Ls Rs LFE |
| 10 | L R C Ls Lb Rb Rs |
| 11 | L R C Ls Lb Rb Rs LFE |

- Downmix: center and surrounds at −3 dB, mono surround at −6 dB to each side, LFE dropped, normalized so a full-scale sum cannot clip. Mono feeds both sides at unity.

- [ ] **Step 1: Write the failing tests**

`src/engine/decode/lpcm.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { UnsupportedCodecError } from './decoder';
import { decodeLpcm, parseLpcmHeader } from './lpcm';

function lpcm(assignment: number, rateCode: number, bitsCode: number, frames: number[][]): Uint8Array {
  const bytesPerSample = bitsCode === 1 ? 2 : 3;
  const bytes: number[] = [0, 0, (assignment << 4) | rateCode, bitsCode << 6];
  for (const frame of frames) {
    for (const sample of frame) {
      const v = sample < 0 ? sample + (bytesPerSample === 2 ? 0x10000 : 0x1000000) : sample;
      if (bytesPerSample === 3) bytes.push((v >> 16) & 0xff);
      bytes.push((v >> 8) & 0xff, v & 0xff);
    }
  }
  const size = bytes.length - 4;
  bytes[0] = size >> 8;
  bytes[1] = size & 0xff;
  return new Uint8Array(bytes);
}

describe('LPCM', () => {
  it('parses the header, padding odd channel counts', () => {
    expect(parseLpcmHeader(lpcm(9, 4, 3, []))).toEqual({ channelAssignment: 9, sampleRate: 96_000, bitsPerSample: 24, codedChannels: 6, storedChannels: 6 });
    expect(parseLpcmHeader(lpcm(1, 5, 1, []))).toMatchObject({ sampleRate: 192_000, codedChannels: 1, storedChannels: 2 });
    expect(parseLpcmHeader(lpcm(8, 1, 1, []))).toMatchObject({ codedChannels: 5, storedChannels: 6 });
  });

  it('decodes 16-bit stereo', () => {
    const chunk = decodeLpcm(lpcm(3, 1, 1, [[16384, -16384], [32767, -32768]]), 1_000);
    expect(chunk).toMatchObject({ ptsUs: 1_000, sampleRate: 48_000, frames: 2 });
    expect(Array.from(chunk.stereo)).toEqual([0.5, -0.5, 32767 / 32768, -1]);
  });

  it('feeds mono to both sides and ignores the padding channel', () => {
    const chunk = decodeLpcm(lpcm(1, 1, 1, [[8192, 999]]), 0);
    expect(Array.from(chunk.stereo)).toEqual([0.25, 0.25]);
  });

  it('downmixes 24-bit 5.1 and drops LFE', () => {
    const chunk = decodeLpcm(lpcm(9, 1, 3, [[0x400000, 0, 0, 0, 0, 0x7fffff]]), 0);
    const norm = 1 / (1 + 2 * Math.SQRT1_2);
    expect(chunk.stereo[0]).toBeCloseTo(0.5 * norm, 6);
    expect(chunk.stereo[1]).toBe(0);
  });

  it('rejects 20-bit samples as unsupported', () => {
    expect(() => decodeLpcm(lpcm(3, 1, 2, []), 0)).toThrow(UnsupportedCodecError);
  });

  it('rejects reserved sample rates', () => {
    expect(() => parseLpcmHeader(lpcm(3, 2, 1, []))).toThrow(/sample rate/);
  });
});
```

`src/engine/decode/decimator.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { Decimator } from './decimator';
import type { PcmChunk } from './lpcm';

function tone(rate: number, frames: number, hz: number, ptsUs = 0): PcmChunk {
  const stereo = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const v = hz === 0 ? 0.5 : 0.5 * Math.sin((2 * Math.PI * hz * i) / rate);
    stereo[i * 2] = v;
    stereo[i * 2 + 1] = v;
  }
  return { ptsUs, sampleRate: rate, frames, stereo };
}

function rms(samples: Float32Array, skipFrames: number): number {
  let sum = 0;
  let n = 0;
  for (let i = skipFrames * 2; i < samples.length; i += 2) {
    sum += samples[i] * samples[i];
    n++;
  }
  return Math.sqrt(sum / n);
}

describe('Decimator', () => {
  it('halves 96 kHz to 48 kHz and keeps DC', () => {
    const out = new Decimator(2).process(tone(96_000, 9600, 0));
    expect(out.sampleRate).toBe(48_000);
    expect(out.frames).toBe(4800);
    expect(out.stereo[4000 * 2]).toBeCloseTo(0.5, 3);
  });

  it('passes 1 kHz and attenuates 30 kHz by more than 40 dB', () => {
    const pass = rms(new Decimator(2).process(tone(96_000, 9600, 1000)).stereo, 200);
    expect(pass).toBeCloseTo(0.5 / Math.SQRT2, 2);
    const stop = rms(new Decimator(2).process(tone(96_000, 9600, 30_000)).stereo, 200);
    expect(stop).toBeLessThan((0.5 / Math.SQRT2) * 0.01);
  });

  it('quarters 192 kHz', () => {
    const out = new Decimator(4).process(tone(192_000, 1920, 0));
    expect(out).toMatchObject({ sampleRate: 48_000, frames: 480 });
  });

  it('produces identical output when the input is split at arbitrary points', () => {
    const whole = new Decimator(2).process(tone(96_000, 2000, 440));
    const input = tone(96_000, 2000, 440);
    const d = new Decimator(2);
    const a = d.process({ ...input, frames: 481, stereo: input.stereo.subarray(0, 962) });
    const b = d.process({ ...input, ptsUs: 481 * (1e6 / 96_000), frames: 1519, stereo: input.stereo.subarray(962) });
    expect([...a.stereo, ...b.stereo]).toEqual([...whole.stereo]);
    expect(b.ptsUs).toBeCloseTo(482 * (1e6 / 96_000), 6);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/engine/decode/lpcm.test.ts src/engine/decode/decimator.test.ts`
Expected: FAIL, because the modules cannot be resolved.

- [ ] **Step 3: Implement `src/engine/decode/lpcm.ts`**

```ts
import { CodingType } from '../bdmv/stream-types';
import { UnsupportedCodecError } from './decoder';

export interface LpcmHeader {
  readonly channelAssignment: number;
  readonly sampleRate: number;
  readonly bitsPerSample: 16 | 24;
  readonly codedChannels: number;
  /** Channels actually stored per frame (padded to even). */
  readonly storedChannels: number;
}

export interface PcmChunk {
  readonly ptsUs: number;
  readonly sampleRate: number;
  readonly frames: number;
  /** Interleaved L, R. */
  readonly stereo: Float32Array;
}

type Role = 'L' | 'R' | 'C' | 'S' | 'Ls' | 'Rs' | 'Lb' | 'Rb' | 'LFE';

/** Coded channel order per channel_assignment (Blu-ray Part 3; FFmpeg pcm-bluray.c). */
const LAYOUTS: Readonly<Record<number, readonly Role[]>> = {
  1: ['C'],
  3: ['L', 'R'],
  4: ['L', 'R', 'C'],
  5: ['L', 'R', 'S'],
  6: ['L', 'R', 'C', 'S'],
  7: ['L', 'R', 'Ls', 'Rs'],
  8: ['L', 'R', 'C', 'Ls', 'Rs'],
  9: ['L', 'R', 'C', 'Ls', 'Rs', 'LFE'],
  10: ['L', 'R', 'C', 'Ls', 'Lb', 'Rb', 'Rs'],
  11: ['L', 'R', 'C', 'Ls', 'Lb', 'Rb', 'Rs', 'LFE'],
};

const M3DB = Math.SQRT1_2;
const DOWNMIX: Readonly<Record<Role, readonly [number, number]>> = {
  L: [1, 0],
  R: [0, 1],
  C: [M3DB, M3DB],
  S: [0.5, 0.5],
  Ls: [M3DB, 0],
  Rs: [0, M3DB],
  Lb: [M3DB, 0],
  Rb: [0, M3DB],
  LFE: [0, 0],
};

const SAMPLE_RATES: Readonly<Record<number, number>> = { 1: 48_000, 4: 96_000, 5: 192_000 };

export function parseLpcmHeader(payload: Uint8Array): LpcmHeader {
  if (payload.length < 4) throw new Error('LPCM payload is shorter than its header');
  const channelAssignment = payload[2] >> 4;
  const layout = LAYOUTS[channelAssignment];
  if (!layout) throw new Error(`reserved LPCM channel assignment ${channelAssignment}`);
  const sampleRate = SAMPLE_RATES[payload[2] & 0x0f];
  if (!sampleRate) throw new Error(`reserved LPCM sample rate code ${payload[2] & 0x0f}`);
  const bitsCode = payload[3] >> 6;
  if (bitsCode === 2) throw new UnsupportedCodecError(CodingType.LPCM, '20-bit LPCM audio is not supported.');
  if (bitsCode !== 1 && bitsCode !== 3) throw new Error(`reserved LPCM sample size code ${bitsCode}`);
  const codedChannels = layout.length;
  return {
    channelAssignment,
    sampleRate,
    bitsPerSample: bitsCode === 1 ? 16 : 24,
    codedChannels,
    storedChannels: codedChannels + (codedChannels % 2),
  };
}

export function decodeLpcm(payload: Uint8Array, ptsUs: number): PcmChunk {
  const header = parseLpcmHeader(payload);
  const layout = LAYOUTS[header.channelAssignment];
  const bytesPerSample = header.bitsPerSample / 8;
  const frameBytes = header.storedChannels * bytesPerSample;
  const frames = Math.floor((payload.length - 4) / frameBytes);
  const gainL = layout.map((role) => DOWNMIX[role][0]);
  const gainR = layout.map((role) => DOWNMIX[role][1]);
  const mono = header.codedChannels === 1;
  const norm = mono ? 1 : 1 / Math.max(1, gainL.reduce((a, b) => a + b, 0));
  const stereo = new Float32Array(frames * 2);
  let o = 4;
  for (let f = 0; f < frames; f++) {
    let l = 0;
    let r = 0;
    for (let ch = 0; ch < header.storedChannels; ch++) {
      let s: number;
      if (bytesPerSample === 2) {
        const v = (payload[o] << 8) | payload[o + 1];
        s = (v & 0x8000 ? v - 0x10000 : v) / 32768;
      } else {
        const v = (payload[o] << 16) | (payload[o + 1] << 8) | payload[o + 2];
        s = (v & 0x800000 ? v - 0x1000000 : v) / 8388608;
      }
      o += bytesPerSample;
      if (ch >= header.codedChannels) continue;
      if (mono) {
        l = s;
        r = s;
      } else {
        l += s * gainL[ch];
        r += s * gainR[ch];
      }
    }
    stereo[f * 2] = l * norm;
    stereo[f * 2 + 1] = r * norm;
  }
  return { ptsUs, sampleRate: header.sampleRate, frames, stereo };
}
```

- [ ] **Step 4: Implement `src/engine/decode/decimator.ts`**

```ts
import type { PcmChunk } from './lpcm';

/** Integer-factor decimator (96/192 kHz → 48 kHz) with a Hamming-windowed sinc low-pass, stateful across chunks. */
export class Decimator {
  private readonly coeffs: Float32Array;
  private history: Float32Array;
  private phase = 0;

  constructor(
    readonly factor: number,
    tapsPerPhase = 16,
  ) {
    const taps = tapsPerPhase * factor * 2 + 1;
    const cutoff = 0.45 / factor; // as a fraction of the input rate
    const coeffs = new Float32Array(taps);
    const mid = (taps - 1) / 2;
    let sum = 0;
    for (let n = 0; n < taps; n++) {
      const x = n - mid;
      const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
      const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (taps - 1));
      coeffs[n] = sinc * window;
      sum += coeffs[n];
    }
    for (let n = 0; n < taps; n++) coeffs[n] /= sum;
    this.coeffs = coeffs;
    this.history = new Float32Array((taps - 1) * 2);
  }

  process(input: PcmChunk): PcmChunk {
    const f = this.factor;
    const taps = this.coeffs.length;
    const historyFrames = this.history.length / 2;
    const total = historyFrames + input.frames;
    const buf = new Float32Array(total * 2);
    buf.set(this.history);
    buf.set(input.stereo.subarray(0, input.frames * 2), this.history.length);

    const firstIndex = (f - this.phase) % f;
    const out = new Float32Array((Math.ceil(input.frames / f) + 1) * 2);
    let frames = 0;
    for (let n = firstIndex; n < input.frames; n += f) {
      const end = historyFrames + n;
      let l = 0;
      let r = 0;
      for (let k = 0; k < taps; k++) {
        const idx = (end - k) * 2;
        l += buf[idx] * this.coeffs[k];
        r += buf[idx + 1] * this.coeffs[k];
      }
      out[frames * 2] = l;
      out[frames * 2 + 1] = r;
      frames++;
    }
    this.phase = (this.phase + input.frames) % f;
    this.history = buf.slice((total - (taps - 1)) * 2);
    return {
      ptsUs: input.ptsUs + (firstIndex * 1e6) / input.sampleRate,
      sampleRate: input.sampleRate / f,
      frames,
      stereo: out.subarray(0, frames * 2),
    };
  }

  reset(): void {
    this.history.fill(0);
    this.phase = 0;
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/engine/decode && npm run typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/engine/decode/lpcm.ts src/engine/decode/lpcm.test.ts src/engine/decode/decimator.ts src/engine/decode/decimator.test.ts
git commit -m "feat(engine): decode Blu-ray LPCM to stereo and decimate high sample rates"
```

---

### Task 12: Shared audio ring, worklet render logic, and the audio writer

**Files:**
- Create: `src/engine/audio/ring.ts`, `src/engine/audio/audio-writer.ts`
- Test: `src/engine/audio/ring.test.ts`, `src/engine/audio/audio-writer.test.ts`

**Interfaces:**
- Consumes: `PcmChunk` (Task 11).
- Produces:
  - `Control` slot indices `{ Playing, DiscardRequest, LatencyUs, Heartbeat, Underruns, Capacity, SampleRate }`
  - `interface RingViews { counters: BigInt64Array; control: Int32Array; data: Float32Array; capacity; sampleRate }`
  - `createRing(sampleRate, seconds): SharedArrayBuffer`; `ringViews(sab): RingViews`
  - `renderQuantum(views, left, right): void`, the AudioWorklet's whole job
  - `class RingWriter(views, nowMs?)` with `sampleRate`, `readFrames()`, `writtenFrames()`, `buffered()`, `latencyUs()`, `heartbeat()`, `underruns()`, `playing`, `setPlaying(on)`, `writeAt(frameIndex, stereo): boolean`, `requestDiscard(): Promise<void>`
  - `class AudioWriter(ring)` with `start(baseUs)`, `enqueue(chunk)`, `drain()`, `queuedChunks`, `frameAt(us)`

Design:
- The ring stores interleaved stereo float frames.
- Two monotonically increasing frame counters (`Written`, `Read`) live in a `BigInt64Array`. Only the worklet advances `Read`, and only the writer advances `Written`.
- While playing, the worklet advances `Read` by one render quantum **even on underrun** (it outputs silence), so the audio clock never stalls. Late samples are then dropped by the writer. This prevents the "video queue full while waiting for audio" deadlock (Review Focus #3).
- Writes are positioned by absolute frame index computed from PTS, so gaps become silence and overlaps are trimmed.
- Discards (on seek) are performed by the worklet at a quantum boundary on request. If the worklet is not running (no heartbeat for 100 ms), the writer performs the discard itself.

- [ ] **Step 1: Write the failing tests**

`src/engine/audio/ring.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { Control, RingWriter, createRing, renderQuantum, ringViews } from './ring';

function stereo(frames: number, value: number): Float32Array {
  return new Float32Array(frames * 2).fill(value);
}

function quantum(views: ReturnType<typeof ringViews>, frames = 128): { left: Float32Array; right: Float32Array } {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  renderQuantum(views, left, right);
  return { left, right };
}

describe('audio ring', () => {
  it('stores capacity and sample rate in the buffer', () => {
    const views = ringViews(createRing(48_000, 0.5));
    expect(views.capacity).toBe(24_000);
    expect(views.sampleRate).toBe(48_000);
  });

  it('outputs silence and does not advance while paused', () => {
    const views = ringViews(createRing(48_000, 1));
    const writer = new RingWriter(views);
    writer.writeAt(0, stereo(256, 0.5));
    const { left } = quantum(views);
    expect(left.every((v) => v === 0)).toBe(true);
    expect(writer.readFrames()).toBe(0);
    expect(views.control[Control.Heartbeat]).toBe(1);
  });

  it('plays written frames in order while playing', () => {
    const views = ringViews(createRing(48_000, 1));
    const writer = new RingWriter(views);
    const data = new Float32Array(256);
    for (let i = 0; i < 128; i++) {
      data[i * 2] = i;
      data[i * 2 + 1] = -i;
    }
    writer.writeAt(0, data);
    writer.setPlaying(true);
    const { left, right } = quantum(views);
    expect(left[5]).toBe(5);
    expect(right[5]).toBe(-5);
    expect(writer.readFrames()).toBe(128);
    expect(writer.buffered()).toBe(0);
  });

  it('keeps advancing on underrun and counts it', () => {
    const views = ringViews(createRing(48_000, 1));
    const writer = new RingWriter(views);
    writer.writeAt(0, stereo(64, 0.25));
    writer.setPlaying(true);
    const { left } = quantum(views);
    expect(left[63]).toBe(0.25);
    expect(left[64]).toBe(0);
    expect(writer.readFrames()).toBe(128);
    expect(writer.underruns()).toBe(1);
  });

  it('writeAt fills gaps with silence, trims overlap and late samples, and refuses when full', () => {
    const views = ringViews(createRing(1000, 1)); // capacity 1000 frames
    const writer = new RingWriter(views);
    expect(writer.writeAt(10, stereo(10, 1))).toBe(true); // gap 0..9 becomes silence
    expect(writer.writtenFrames()).toBe(20);
    expect(writer.writeAt(15, stereo(10, 2))).toBe(true); // overlap 15..19 trimmed
    expect(writer.writtenFrames()).toBe(25);
    expect(writer.writeAt(0, stereo(5, 3))).toBe(true); // entirely late: dropped
    expect(writer.writtenFrames()).toBe(25);
    expect(views.data[0]).toBe(0);
    expect(views.data[10 * 2]).toBe(1);
    expect(views.data[20 * 2]).toBe(2);
    expect(writer.writeAt(25, stereo(976, 4))).toBe(false); // would exceed capacity
    expect(writer.writtenFrames()).toBe(25);
  });

  it('continues writing at the read head after an underrun skipped past the written end', () => {
    const views = ringViews(createRing(48_000, 1));
    const writer = new RingWriter(views);
    writer.setPlaying(true);
    quantum(views); // read = 128, written = 0
    expect(writer.writeAt(100, stereo(100, 1))).toBe(true); // frames 100..127 are late
    expect(writer.writtenFrames()).toBe(200);
    const { left } = quantum(views);
    expect(left[0]).toBe(1);
  });

  it('discards buffered audio via the worklet', async () => {
    const views = ringViews(createRing(48_000, 1));
    const writer = new RingWriter(views);
    writer.writeAt(0, stereo(1000, 1));
    const done = writer.requestDiscard();
    quantum(views);
    await done;
    expect(writer.readFrames()).toBe(1000);
    expect(writer.buffered()).toBe(0);
  });

  it('discards by itself when the worklet is not running', async () => {
    const views = ringViews(createRing(48_000, 1));
    let now = 0;
    const writer = new RingWriter(views, () => (now += 60));
    writer.writeAt(0, stereo(500, 1));
    await writer.requestDiscard();
    expect(writer.readFrames()).toBe(500);
    expect(views.control[Control.DiscardRequest]).toBe(0);
  });
});
```

`src/engine/audio/audio-writer.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { PcmChunk } from '../decode/lpcm';
import { AudioWriter } from './audio-writer';
import { RingWriter, createRing, renderQuantum, ringViews } from './ring';

function chunk(ptsUs: number, frames: number, value: number, sampleRate = 48_000): PcmChunk {
  return { ptsUs, sampleRate, frames, stereo: new Float32Array(frames * 2).fill(value) };
}

function setup(seconds = 1): { writer: AudioWriter; ring: RingWriter; views: ReturnType<typeof ringViews> } {
  const views = ringViews(createRing(48_000, seconds));
  const ring = new RingWriter(views);
  return { writer: new AudioWriter(ring), ring, views };
}

describe('AudioWriter', () => {
  it('places chunks by PTS relative to the start time', () => {
    const { writer, ring, views } = setup();
    writer.start(10_000_000);
    writer.enqueue(chunk(10_000_000, 240, 1));
    writer.enqueue(chunk(10_010_000, 240, 2)); // 5 ms gap → 240 frames of silence
    expect(ring.writtenFrames()).toBe(720);
    expect(views.data[239 * 2]).toBe(1);
    expect(views.data[240 * 2]).toBe(0);
    expect(views.data[480 * 2]).toBe(2);
  });

  it('drops samples before the start time (seek trimming)', () => {
    const { writer, ring, views } = setup();
    writer.start(1_000_000);
    writer.enqueue(chunk(995_000, 480, 7)); // first 240 frames precede the start
    expect(ring.writtenFrames()).toBe(240);
    expect(views.data[0]).toBe(7);
  });

  it('queues chunks while the ring is full and drains when the reader advances', () => {
    const { writer, ring, views } = setup(0.01); // 480 frames
    writer.start(0);
    writer.enqueue(chunk(0, 480, 1));
    writer.enqueue(chunk(10_000, 240, 2));
    expect(writer.queuedChunks).toBe(1);
    ring.setPlaying(true);
    renderQuantum(views, new Float32Array(128), new Float32Array(128));
    renderQuantum(views, new Float32Array(128), new Float32Array(128));
    writer.drain();
    expect(writer.queuedChunks).toBe(0);
    expect(ring.writtenFrames()).toBe(720);
  });

  it('maps media time to frames from the read head at start()', () => {
    const { writer, ring, views } = setup();
    ring.setPlaying(true);
    renderQuantum(views, new Float32Array(128), new Float32Array(128));
    writer.start(2_000_000);
    expect(writer.frameAt(2_000_000)).toBe(128);
    expect(writer.frameAt(2_001_000)).toBe(176);
  });

  it('rejects chunks at the wrong sample rate', () => {
    const { writer } = setup();
    writer.start(0);
    expect(() => writer.enqueue(chunk(0, 10, 1, 96_000))).toThrow(/sample rate/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/engine/audio`
Expected: FAIL, because the modules cannot be resolved.

- [ ] **Step 3: Implement `src/engine/audio/ring.ts`**

```ts
/** Control slot indices (Int32). */
export const Control = {
  Playing: 0,
  DiscardRequest: 1,
  LatencyUs: 2,
  Heartbeat: 3,
  Underruns: 4,
  Capacity: 5,
  SampleRate: 6,
} as const;

const CONTROL_SLOTS = 8;
const COUNTER_WRITTEN = 0;
const COUNTER_READ = 1;
const COUNTERS_BYTES = 16;
const HEADER_BYTES = COUNTERS_BYTES + CONTROL_SLOTS * 4;

export interface RingViews {
  /** [written frames, read frames], monotonically increasing. */
  readonly counters: BigInt64Array;
  readonly control: Int32Array;
  /** Interleaved stereo frames, `capacity` long. */
  readonly data: Float32Array;
  readonly capacity: number;
  readonly sampleRate: number;
}

export function createRing(sampleRate: number, seconds: number): SharedArrayBuffer {
  const capacity = Math.ceil(sampleRate * seconds);
  const sab = new SharedArrayBuffer(HEADER_BYTES + capacity * 2 * Float32Array.BYTES_PER_ELEMENT);
  const control = new Int32Array(sab, COUNTERS_BYTES, CONTROL_SLOTS);
  control[Control.Capacity] = capacity;
  control[Control.SampleRate] = sampleRate;
  return sab;
}

export function ringViews(sab: SharedArrayBuffer): RingViews {
  const counters = new BigInt64Array(sab, 0, 2);
  const control = new Int32Array(sab, COUNTERS_BYTES, CONTROL_SLOTS);
  const capacity = control[Control.Capacity];
  return { counters, control, data: new Float32Array(sab, HEADER_BYTES, capacity * 2), capacity, sampleRate: control[Control.SampleRate] };
}

/** One AudioWorklet render quantum. Runs on the audio thread; must not allocate. */
export function renderQuantum(views: RingViews, left: Float32Array, right: Float32Array): void {
  const { counters, control, data, capacity } = views;
  Atomics.add(control, Control.Heartbeat, 1);
  if (Atomics.load(control, Control.DiscardRequest) === 1) {
    Atomics.store(counters, COUNTER_READ, Atomics.load(counters, COUNTER_WRITTEN));
    Atomics.store(control, Control.DiscardRequest, 0);
  }
  const frames = left.length;
  if (Atomics.load(control, Control.Playing) !== 1) {
    left.fill(0);
    right.fill(0);
    return;
  }
  const read = Number(Atomics.load(counters, COUNTER_READ));
  const written = Number(Atomics.load(counters, COUNTER_WRITTEN));
  const available = Math.max(0, Math.min(frames, written - read));
  for (let i = 0; i < available; i++) {
    const p = ((read + i) % capacity) * 2;
    left[i] = data[p];
    right[i] = data[p + 1];
  }
  left.fill(0, available);
  right.fill(0, available);
  if (available < frames) Atomics.add(control, Control.Underruns, 1);
  Atomics.store(counters, COUNTER_READ, BigInt(read + frames));
}

/** Engine-side access to the ring. */
export class RingWriter {
  constructor(
    readonly views: RingViews,
    private readonly nowMs: () => number = () => performance.now(),
  ) {}

  get sampleRate(): number {
    return this.views.sampleRate;
  }

  get playing(): boolean {
    return Atomics.load(this.views.control, Control.Playing) === 1;
  }

  readFrames(): number {
    return Number(Atomics.load(this.views.counters, COUNTER_READ));
  }

  writtenFrames(): number {
    return Number(Atomics.load(this.views.counters, COUNTER_WRITTEN));
  }

  buffered(): number {
    return Math.max(0, this.writtenFrames() - this.readFrames());
  }

  latencyUs(): number {
    return Math.max(0, Atomics.load(this.views.control, Control.LatencyUs));
  }

  heartbeat(): number {
    return Atomics.load(this.views.control, Control.Heartbeat);
  }

  underruns(): number {
    return Atomics.load(this.views.control, Control.Underruns);
  }

  setPlaying(on: boolean): void {
    Atomics.store(this.views.control, Control.Playing, on ? 1 : 0);
  }

  /**
   * Writes stereo frames at absolute frame index `at`. Frames before the read head or already written are
   * trimmed; a gap after the written end is filled with silence. Returns false (writing nothing) if the
   * frames would not fit in the ring yet.
   */
  writeAt(at: number, stereo: Float32Array): boolean {
    const { data, capacity } = this.views;
    const read = this.readFrames();
    const written = Math.max(this.writtenFrames(), read);
    let frames = stereo.length / 2;
    let src = 0;
    let start = at;
    if (start < written) {
      const skip = written - start;
      if (skip >= frames) return true;
      src = skip;
      start = written;
      frames -= skip;
    }
    const end = start + frames;
    if (end - read > capacity) return false;
    for (let f = written; f < start; f++) {
      const p = (f % capacity) * 2;
      data[p] = 0;
      data[p + 1] = 0;
    }
    for (let i = 0; i < frames; i++) {
      const p = ((start + i) % capacity) * 2;
      data[p] = stereo[(src + i) * 2];
      data[p + 1] = stereo[(src + i) * 2 + 1];
    }
    Atomics.store(this.views.counters, COUNTER_WRITTEN, BigInt(end));
    return true;
  }

  /** Drops everything buffered. The worklet does it at a quantum boundary; if it is not running, we do it. */
  async requestDiscard(): Promise<void> {
    const { control, counters } = this.views;
    Atomics.store(control, Control.DiscardRequest, 1);
    const startMs = this.nowMs();
    const beat = this.heartbeat();
    while (Atomics.load(control, Control.DiscardRequest) === 1) {
      if (this.nowMs() - startMs > 100 && this.heartbeat() === beat) {
        Atomics.store(counters, COUNTER_READ, Atomics.load(counters, COUNTER_WRITTEN));
        Atomics.store(control, Control.DiscardRequest, 0);
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
  }
}
```

- [ ] **Step 4: Implement `src/engine/audio/audio-writer.ts`**

```ts
import type { PcmChunk } from '../decode/lpcm';
import type { RingWriter } from './ring';

/** Places decoded PCM into the ring at the frame position implied by its PTS. */
export class AudioWriter {
  private baseUs = 0;
  private baseFrame = 0;
  private readonly queue: PcmChunk[] = [];

  constructor(private readonly ring: RingWriter) {}

  /** Call after a discard: media time `baseUs` maps to the current read head. */
  start(baseUs: number): void {
    this.baseUs = baseUs;
    this.baseFrame = this.ring.readFrames();
    this.queue.length = 0;
  }

  get queuedChunks(): number {
    return this.queue.length;
  }

  frameAt(us: number): number {
    return this.baseFrame + Math.round(((us - this.baseUs) * this.ring.sampleRate) / 1e6);
  }

  enqueue(chunk: PcmChunk): void {
    if (chunk.sampleRate !== this.ring.sampleRate) {
      throw new Error(`chunk sample rate ${chunk.sampleRate} does not match output ${this.ring.sampleRate}`);
    }
    this.queue.push(chunk);
    this.drain();
  }

  drain(): void {
    while (this.queue.length > 0) {
      const chunk = this.queue[0];
      if (!this.ring.writeAt(this.frameAt(chunk.ptsUs), chunk.stereo.subarray(0, chunk.frames * 2))) return;
      this.queue.shift();
    }
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/engine/audio && npm run typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/engine/audio
git commit -m "feat(engine): add SharedArrayBuffer audio ring, worklet render logic and PTS-placed writer"
```

---

### Task 13: Master clock

**Files:**
- Create: `src/engine/clock/master-clock.ts`
- Test: `src/engine/clock/master-clock.test.ts`

**Interfaces:**
- Consumes: none at runtime (`RingWriter` satisfies `AudioClockSource` structurally).
- Produces:
  - `interface AudioClockSource { readFrames(): number; readonly sampleRate: number; latencyUs(): number }`
  - `type ClockMode = 'audio' | 'wall'`
  - `class MasterClock(nowMs)` with `mode`, `useAudio(source, baseUs)`, `useWall(baseUs, running)`, `setRunning(running)` (wall mode only), and `nowUs()`

Spec formula: `clock = basePts + framesPlayed / sampleRate − outputLatency`, clamped at `basePts`. Audio mode pauses implicitly because the worklet stops advancing `Read` when not playing.

- [ ] **Step 1: Write the failing tests**

`src/engine/clock/master-clock.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { MasterClock, type AudioClockSource } from './master-clock';

class FakeAudio implements AudioClockSource {
  frames = 0;
  latency = 0;
  readonly sampleRate = 48_000;
  readFrames(): number {
    return this.frames;
  }
  latencyUs(): number {
    return this.latency;
  }
}

describe('MasterClock', () => {
  it('wall mode holds while paused and advances while running', () => {
    let now = 1000;
    const clock = new MasterClock(() => now);
    clock.useWall(5_000_000, false);
    now += 500;
    expect(clock.nowUs()).toBe(5_000_000);
    clock.setRunning(true);
    now += 250;
    expect(clock.nowUs()).toBe(5_250_000);
    clock.setRunning(false);
    now += 1000;
    expect(clock.nowUs()).toBe(5_250_000);
    clock.setRunning(true);
    now += 100;
    expect(clock.nowUs()).toBe(5_350_000);
  });

  it('audio mode follows frames played minus output latency, clamped at the base', () => {
    const audio = new FakeAudio();
    audio.frames = 4800;
    const clock = new MasterClock(() => 0);
    clock.useAudio(audio, 2_000_000);
    expect(clock.mode).toBe('audio');
    audio.latency = 20_000;
    expect(clock.nowUs()).toBe(2_000_000);
    audio.frames += 4800; // 100 ms played
    expect(clock.nowUs()).toBe(2_080_000);
  });

  it('switches from audio to wall without a jump', () => {
    let now = 0;
    const audio = new FakeAudio();
    const clock = new MasterClock(() => now);
    clock.useAudio(audio, 0);
    audio.frames = 48_000;
    const t = clock.nowUs();
    clock.useWall(t, true);
    now += 10;
    expect(clock.mode).toBe('wall');
    expect(clock.nowUs()).toBe(1_010_000);
  });

  it('ignores setRunning in audio mode', () => {
    const audio = new FakeAudio();
    const clock = new MasterClock(() => 0);
    clock.useAudio(audio, 0);
    clock.setRunning(true);
    expect(clock.nowUs()).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/engine/clock`
Expected: FAIL, because `./master-clock` cannot be resolved.

- [ ] **Step 3: Implement `src/engine/clock/master-clock.ts`**

```ts
export interface AudioClockSource {
  readFrames(): number;
  readonly sampleRate: number;
  latencyUs(): number;
}

export type ClockMode = 'audio' | 'wall';

/** Playlist-time clock driven by audio frames played, or by wall time when there is no audio. */
export class MasterClock {
  private clockMode: ClockMode = 'wall';
  private audio: AudioClockSource | null = null;
  private baseUs = 0;
  private baseFrame = 0;
  private wallStartMs: number | null = null;

  constructor(private readonly nowMs: () => number) {}

  get mode(): ClockMode {
    return this.clockMode;
  }

  useAudio(source: AudioClockSource, baseUs: number): void {
    this.clockMode = 'audio';
    this.audio = source;
    this.baseUs = baseUs;
    this.baseFrame = source.readFrames();
    this.wallStartMs = null;
  }

  useWall(baseUs: number, running: boolean): void {
    this.clockMode = 'wall';
    this.audio = null;
    this.baseUs = baseUs;
    this.wallStartMs = running ? this.nowMs() : null;
  }

  setRunning(running: boolean): void {
    if (this.clockMode !== 'wall') return;
    if (running && this.wallStartMs === null) {
      this.wallStartMs = this.nowMs();
    } else if (!running && this.wallStartMs !== null) {
      this.baseUs = this.nowUs();
      this.wallStartMs = null;
    }
  }

  nowUs(): number {
    if (this.clockMode === 'audio' && this.audio) {
      const playedUs = ((this.audio.readFrames() - this.baseFrame) * 1e6) / this.audio.sampleRate;
      return this.baseUs + Math.max(0, playedUs - this.audio.latencyUs());
    }
    return this.wallStartMs === null ? this.baseUs : this.baseUs + (this.nowMs() - this.wallStartMs) * 1000;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/engine/clock && npm run typecheck`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/engine/clock
git commit -m "feat(engine): add audio-driven master clock with wall-clock fallback"
```

---

### Task 14: Video presenter and compositor

**Files:**
- Create: `src/engine/render/video-presenter.ts`, `src/engine/render/compositor.ts`
- Test: `src/engine/render/video-presenter.test.ts`, `src/engine/render/compositor.test.ts`

**Interfaces:**
- Produces:
  - `interface PresentableFrame { readonly timestamp: number; close(): void }`
  - `class VideoPresenter<F extends PresentableFrame>` with `push(frame)`, `size`, `current`, `select(clockUs): F | null` (the newly shown frame or null), `dropLate(clockUs)`, `clear()`, and the counters `presented` and `dropped`
  - `interface Rect { x; y; width; height }`; `fitRect(srcW, srcH, dstW, dstH): Rect`
  - `interface CompositorLike { resize(width, height): void; drawVideo(frame: VideoFrame | null): void }`; `class Compositor(canvas: OffscreenCanvas)`

Presentation rule: show the newest queued frame with `timestamp ≤ clock`, and close any older ones it skipped. Right after `clear()` (open or seek), if no frame is due yet, show the earliest frame as a preview. That way a paused seek shows a picture.

- [ ] **Step 1: Write the failing tests**

`src/engine/render/video-presenter.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { VideoPresenter, type PresentableFrame } from './video-presenter';

interface TestFrame extends PresentableFrame {
  closed: boolean;
}

function frame(timestamp: number): TestFrame {
  return { timestamp, closed: false, close() { this.closed = true; } };
}

describe('VideoPresenter', () => {
  it('shows the newest due frame and closes skipped ones', () => {
    const p = new VideoPresenter<TestFrame>();
    const [a, b, c] = [frame(0), frame(40_000), frame(80_000)];
    p.push(a);
    p.push(b);
    p.push(c);
    expect(p.select(50_000)).toBe(b);
    expect(a.closed).toBe(true);
    expect(p.dropped).toBe(1);
    expect(p.current).toBe(b);
    expect(p.size).toBe(1);
    expect(p.select(60_000)).toBeNull();
    expect(p.select(80_000)).toBe(c);
    expect(b.closed).toBe(true);
    expect(p.presented).toBe(2);
  });

  it('previews the first frame after clear even if it is not due yet, then holds', () => {
    const p = new VideoPresenter<TestFrame>();
    const [a, b] = [frame(1_000_000), frame(1_040_000)];
    p.push(a);
    p.push(b);
    expect(p.select(900_000)).toBe(a);
    expect(p.select(950_000)).toBeNull();
    expect(p.current).toBe(a);
  });

  it('keeps frames sorted when pushed out of order', () => {
    const p = new VideoPresenter<TestFrame>();
    p.push(frame(80_000));
    p.push(frame(40_000));
    expect(p.select(40_000)?.timestamp).toBe(40_000);
  });

  it('dropLate closes all but the newest due frame', () => {
    const p = new VideoPresenter<TestFrame>();
    const frames = [frame(0), frame(40_000), frame(80_000), frame(120_000)];
    for (const f of frames) p.push(f);
    p.dropLate(90_000);
    expect(frames.map((f) => f.closed)).toEqual([true, true, false, false]);
    expect(p.size).toBe(2);
    expect(p.dropped).toBe(2);
  });

  it('clear closes queued and current frames', () => {
    const p = new VideoPresenter<TestFrame>();
    const [a, b] = [frame(0), frame(40_000)];
    p.push(a);
    p.push(b);
    p.select(0);
    p.clear();
    expect(a.closed && b.closed).toBe(true);
    expect(p.current).toBeNull();
    expect(p.size).toBe(0);
  });
});
```

`src/engine/render/compositor.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { fitRect } from './compositor';

describe('fitRect', () => {
  it('letterboxes wide video into a square', () => {
    expect(fitRect(1920, 1080, 1000, 1000)).toEqual({ x: 0, y: 218, width: 1000, height: 563 });
  });

  it('pillarboxes 4:3 into 16:9', () => {
    expect(fitRect(1440, 1080, 1920, 1080)).toEqual({ x: 240, y: 0, width: 1440, height: 1080 });
  });

  it('scales up to fill an exact match', () => {
    expect(fitRect(1280, 720, 1920, 1080)).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/engine/render`
Expected: FAIL, because the modules cannot be resolved.

- [ ] **Step 3: Implement `video-presenter.ts` and `compositor.ts`**

`src/engine/render/video-presenter.ts`:
```ts
export interface PresentableFrame {
  readonly timestamp: number;
  close(): void;
}

/** Holds decoded frames and picks the one to display for a clock time. Owns (and closes) every frame. */
export class VideoPresenter<F extends PresentableFrame> {
  presented = 0;
  dropped = 0;
  private queue: F[] = [];
  private shown: F | null = null;
  private presentedSinceClear = false;

  get size(): number {
    return this.queue.length;
  }

  get current(): F | null {
    return this.shown;
  }

  push(frame: F): void {
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1].timestamp > frame.timestamp) i--;
    this.queue.splice(i, 0, frame);
  }

  select(clockUs: number): F | null {
    let idx = this.lastDueIndex(clockUs);
    if (idx < 0) {
      if (this.presentedSinceClear || this.queue.length === 0) return null;
      idx = 0;
    }
    for (let i = 0; i < idx; i++) {
      this.queue[i].close();
      this.dropped++;
    }
    const next = this.queue[idx];
    this.queue = this.queue.slice(idx + 1);
    this.shown?.close();
    this.shown = next;
    this.presentedSinceClear = true;
    this.presented++;
    return next;
  }

  /** Closes due frames except the newest one, without presenting (used when rendering is throttled). */
  dropLate(clockUs: number): void {
    const idx = this.lastDueIndex(clockUs);
    if (idx <= 0) return;
    for (let i = 0; i < idx; i++) {
      this.queue[i].close();
      this.dropped++;
    }
    this.queue = this.queue.slice(idx);
  }

  clear(): void {
    for (const f of this.queue) f.close();
    this.queue = [];
    this.shown?.close();
    this.shown = null;
    this.presentedSinceClear = false;
  }

  private lastDueIndex(clockUs: number): number {
    let idx = -1;
    for (let i = 0; i < this.queue.length && this.queue[i].timestamp <= clockUs; i++) idx = i;
    return idx;
  }
}
```

`src/engine/render/compositor.ts`:
```ts
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function fitRect(srcW: number, srcH: number, dstW: number, dstH: number): Rect {
  const scale = Math.min(dstW / srcW, dstH / srcH);
  const width = Math.round(srcW * scale);
  const height = Math.round(srcH * scale);
  return { x: Math.floor((dstW - width) / 2), y: Math.floor((dstH - height) / 2), width, height };
}

export interface CompositorLike {
  resize(width: number, height: number): void;
  drawVideo(frame: VideoFrame | null): void;
}

/** Draws planes onto the transferred canvas. M1 has the video plane only; PG/IG/text arrive in M3/M4. */
export class Compositor implements CompositorLike {
  private readonly ctx: OffscreenCanvasRenderingContext2D;

  constructor(private readonly canvas: OffscreenCanvas) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas context is unavailable');
    this.ctx = ctx;
  }

  resize(width: number, height: number): void {
    this.canvas.width = Math.max(1, Math.round(width));
    this.canvas.height = Math.max(1, Math.round(height));
  }

  drawVideo(frame: VideoFrame | null): void {
    const { width, height } = this.canvas;
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, width, height);
    if (!frame) return;
    const r = fitRect(frame.displayWidth, frame.displayHeight, width, height);
    this.ctx.drawImage(frame, r.x, r.y, r.width, r.height);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/engine/render && npm run typecheck`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add src/engine/render
git commit -m "feat(engine): add clock-driven video presenter and letterboxing compositor"
```

---

### Task 15: Stream selection, synthetic disc builder, and the playback pipeline

**Files:**
- Create: `src/engine/playback/stream-selection.ts`, `src/engine/playback/pipeline.ts`, `tests/helpers/synthetic-disc.ts`
- Test: `src/engine/playback/stream-selection.test.ts`, `src/engine/playback/pipeline.test.ts`

**Interfaces:**
- Consumes: `StnTable`, `StreamEntry` (Task 4); `Clpi`, `findEpBefore`, `findEpAfter` (Task 5); `ByteSource`, `DiscError`, `clipInfoPath`, `streamPath`, `FileSource`, `normalizeDiscPaths`, `loadClips` (Task 6); `Timeline` (Task 7); `M2tsReader`, `DemuxStats` (Task 8); builders, `muxM2ts`, `avcAu`.
- Produces:
  - `PLAYABLE_AUDIO: ReadonlySet<number>` (M1: LPCM)
  - `interface StreamChoice { video; audio; unsupportedAudio }`; `chooseStreams(stn, playableAudio?)`
  - `interface PipelineUnit { data; ptsUs; inRange }`
  - `interface PipelineSinks { video(u); audio(u); isFull(): boolean; ended(): void; failed(err): void }`
  - `interface PipelineConfig { source; timeline; clips; videoPid; audioPid: number | null }`
  - `class PlaybackPipeline(config, sinks, wait?)` with `start(fromUs)`, `stop()`, `stats`
  - Test helpers:
    - `VIDEO_PID`, `AUDIO_PID`, `FRAME_TICKS_90K` (3750 = 24 fps), `CLIP_START_PTS` (900000)
    - `buildSyntheticDisc(spec)` returns a `Map<path, bytes>`, with paths in on-disc case (e.g. `BDMV/STREAM/00001.m2ts`)
    - `syntheticClip(clipId, seconds, opts?)`, `discEntries(files, root?): Array<[string, File]>`, `syntheticSource(files): FileSource`

The pipeline reads play items in order. For each item it opens the clip at the EP entry before the start time and stops at the EP entry after `out_time`. It maps every PES to playlist time and hands it to the sinks. It waits while `isFull()` returns true. `stop()` (or a later `start()`) cancels a running read loop through a generation counter.

- [ ] **Step 1: Write the synthetic disc builder**

`tests/helpers/synthetic-disc.ts`:
```ts
import { CodingType } from '../../src/engine/bdmv/stream-types';
import { FileSource } from '../../src/engine/disc/file-source';
import { normalizeDiscPaths } from '../../src/engine/disc/paths';
import { buildClpi, buildIndex, buildMpls, type MarkSpec } from './bdmv-builders';
import { avcAu } from './h264-units';
import { muxM2ts, type MuxUnit } from './ts-muxer';

export const VIDEO_PID = 0x1011;
export const AUDIO_PID = 0x1100;
/** 24 fps in 90 kHz ticks. */
export const FRAME_TICKS_90K = 3750;
/** 5 ms of 48 kHz audio per LPCM PES (450 ticks at 90 kHz). */
export const AUDIO_FRAMES_PER_PES = 240;
const AUDIO_PES_TICKS_90K = 450;
export const CLIP_START_PTS = 900_000;

export interface SyntheticClipSpec {
  clipId: string;
  /** Video access units in decode order, no B-frames, one per frame at 24 fps. */
  videoAus: Uint8Array[];
  /** Indices of IDR units; they become EP-map entries. */
  keyIndices: number[];
  /** 90 kHz PTS of the first frame (even). */
  startPts: number;
  /** Audio coding type: LPCM gets a real 440 Hz tone, other types get dummy payloads. Omit for no audio. */
  audio?: number;
}

export interface SyntheticPlaylistSpec {
  id: string;
  clipIds: string[];
  chapterEverySeconds?: number;
}

export interface SyntheticDiscSpec {
  clips: SyntheticClipSpec[];
  playlists: SyntheticPlaylistSpec[];
}

/** One LPCM PES payload: 48 kHz, 16-bit stereo, 440 Hz at −12 dBFS. */
export function lpcmPayload(frames: number, startFrame: number): Uint8Array {
  const out = new Uint8Array(4 + frames * 4);
  const size = frames * 4;
  out[0] = size >> 8;
  out[1] = size & 0xff;
  out[2] = 0x31; // stereo, 48 kHz
  out[3] = 0x40; // 16-bit
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * (startFrame + i)) / 48_000) * 8192) & 0xffff;
    const o = 4 + i * 4;
    out[o] = v >> 8;
    out[o + 1] = v & 0xff;
    out[o + 2] = v >> 8;
    out[o + 3] = v & 0xff;
  }
  return out;
}

/** A clip of fake AVC units (IDR every `keyEvery` frames), optionally with audio. */
export function syntheticClip(clipId: string, seconds: number, opts: { audio?: number; keyEvery?: number; startPts?: number } = {}): SyntheticClipSpec {
  const keyEvery = opts.keyEvery ?? 24;
  const frames = seconds * 24;
  const videoAus: Uint8Array[] = [];
  const keyIndices: number[] = [];
  for (let i = 0; i < frames; i++) {
    const idr = i % keyEvery === 0;
    if (idr) keyIndices.push(i);
    videoAus.push(avcAu({ idr, fill: 300 }));
  }
  return { clipId, videoAus, keyIndices, startPts: opts.startPts ?? CLIP_START_PTS, audio: opts.audio };
}

export function buildSyntheticDisc(spec: SyntheticDiscSpec): Map<string, Uint8Array<ArrayBuffer>> {
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  files.set('BDMV/index.bdmv', buildIndex({ firstPlay: { kind: 'hdmv', movieObjectId: 0 }, topMenu: { kind: 'hdmv', movieObjectId: 1 }, titles: [{ kind: 'hdmv', movieObjectId: 2 }] }));
  const clips = new Map<string, { inTime: number; outTime: number; audio?: number }>();

  for (const clip of spec.clips) {
    const endPts = clip.startPts + clip.videoAus.length * FRAME_TICKS_90K;
    const units: Array<MuxUnit & { videoIndex?: number }> = clip.videoAus.map((payload, i) => ({
      pid: VIDEO_PID,
      streamId: 0xe0,
      pts: clip.startPts + i * FRAME_TICKS_90K,
      payload,
      videoIndex: i,
    }));
    if (clip.audio !== undefined) {
      const count = Math.ceil((endPts - clip.startPts) / AUDIO_PES_TICKS_90K);
      for (let j = 0; j < count; j++) {
        const payload = clip.audio === CodingType.LPCM ? lpcmPayload(AUDIO_FRAMES_PER_PES, j * AUDIO_FRAMES_PER_PES) : new Uint8Array(64).fill(0x0b);
        units.push({ pid: AUDIO_PID, streamId: 0xbd, pts: clip.startPts + j * AUDIO_PES_TICKS_90K, payload });
      }
    }
    units.sort((a, b) => a.pts - b.pts || (a.pid === AUDIO_PID ? -1 : 1));
    const { bytes, unitSpns } = muxM2ts(units);
    const keySet = new Set(clip.keyIndices);
    const entries = units.flatMap((u, i) =>
      u.videoIndex !== undefined && keySet.has(u.videoIndex) ? [{ pts: Math.floor(u.pts / 2), spn: unitSpns[i] }] : [],
    );
    const streams: Array<{ pid: number; codingType: number }> = [{ pid: VIDEO_PID, codingType: CodingType.AVC }];
    if (clip.audio !== undefined) streams.push({ pid: AUDIO_PID, codingType: clip.audio });
    files.set(`BDMV/STREAM/${clip.clipId}.m2ts`, bytes);
    files.set(
      `BDMV/CLIPINF/${clip.clipId}.clpi`,
      buildClpi({ numSourcePackets: bytes.length / 192, streams, presentationStart: clip.startPts / 2, presentationEnd: endPts / 2, epMaps: [{ pid: VIDEO_PID, entries }] }),
    );
    clips.set(clip.clipId, { inTime: clip.startPts / 2, outTime: endPts / 2, audio: clip.audio });
  }

  for (const playlist of spec.playlists) {
    const marks: MarkSpec[] = [];
    const playItems = playlist.clipIds.map((clipId, index) => {
      const clip = clips.get(clipId);
      if (!clip) throw new Error(`unknown clip ${clipId}`);
      const step = (playlist.chapterEverySeconds ?? 0) * 45_000;
      if (step > 0) for (let t = clip.inTime; t < clip.outTime; t += step) marks.push({ playItemRef: index, time: t });
      return {
        clipId,
        inTime: clip.inTime,
        outTime: clip.outTime,
        connectionCondition: index === 0 ? 1 : 5,
        video: [{ pid: VIDEO_PID, codingType: CodingType.AVC }],
        audio: clip.audio === undefined ? [] : [{ pid: AUDIO_PID, codingType: clip.audio }],
      };
    });
    files.set(`BDMV/PLAYLIST/${playlist.id}.mpls`, buildMpls({ playItems, marks }));
  }
  return files;
}

export function discEntries(files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>, root = 'Disc'): Array<[string, File]> {
  return [...files].map(([path, bytes]) => [`${root}/${path}`, new File([bytes], path.split('/').pop() ?? path)]);
}

export function syntheticSource(files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>): FileSource {
  return new FileSource(normalizeDiscPaths(discEntries(files)));
}
```

- [ ] **Step 2: Write the failing tests**

`src/engine/playback/stream-selection.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { StreamEntry } from '../bdmv/mpls-parser';
import { CodingType } from '../bdmv/stream-types';
import { chooseStreams } from './stream-selection';

const entry = (pid: number, codingType: number, subPath = false): StreamEntry => ({ pid, codingType, format: 0, rate: 0, lang: 'eng', subPath });

describe('chooseStreams', () => {
  it('picks the first main-path video and the first playable audio', () => {
    const choice = chooseStreams({
      video: [entry(0x1b00, CodingType.AVC, true), entry(0x1011, CodingType.AVC)],
      audio: [entry(0x1100, CodingType.AC3), entry(0x1101, CodingType.LPCM)],
      pg: [],
      ig: [],
    });
    expect(choice.video?.pid).toBe(0x1011);
    expect(choice.audio?.pid).toBe(0x1101);
    expect(choice.unsupportedAudio).toEqual([]);
  });

  it('reports unsupported audio when nothing is playable', () => {
    const choice = chooseStreams({ video: [entry(0x1011, CodingType.AVC)], audio: [entry(0x1100, CodingType.TRUEHD), entry(0x1101, CodingType.DTSHD_MASTER)], pg: [], ig: [] });
    expect(choice.audio).toBeNull();
    expect(choice.unsupportedAudio.map((a) => a.codingType)).toEqual([CodingType.TRUEHD, CodingType.DTSHD_MASTER]);
  });

  it('handles playlists without audio or video', () => {
    expect(chooseStreams({ video: [], audio: [], pg: [], ig: [] })).toEqual({ video: null, audio: null, unsupportedAudio: [] });
  });
});
```

`src/engine/playback/pipeline.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { AUDIO_PID, VIDEO_PID, buildSyntheticDisc, syntheticClip, syntheticSource } from '../../../tests/helpers/synthetic-disc';
import { parseMpls } from '../bdmv/mpls-parser';
import { CodingType } from '../bdmv/stream-types';
import { DiscError, readWhole } from '../disc/byte-source';
import { loadClips } from '../disc/open-disc';
import { Timeline } from '../nav/timeline';
import { PlaybackPipeline, type PipelineConfig, type PipelineUnit } from './pipeline';

async function setup(): Promise<PipelineConfig> {
  const files = buildSyntheticDisc({
    clips: [syntheticClip('00001', 4, { audio: CodingType.LPCM }), syntheticClip('00002', 4, { audio: CodingType.LPCM })],
    playlists: [{ id: '00000', clipIds: ['00001', '00002'] }],
  });
  const source = syntheticSource(files);
  const mpls = parseMpls(await readWhole(source, 'BDMV/PLAYLIST/00000.MPLS'));
  return { source, timeline: new Timeline(mpls.playItems), clips: await loadClips(source, ['00001', '00002']), videoPid: VIDEO_PID, audioPid: AUDIO_PID };
}

interface Collected {
  video: PipelineUnit[];
  audio: PipelineUnit[];
  ended: number;
  errors: unknown[];
}

function run(
  config: PipelineConfig,
  fromUs: number,
  isFull: (got: Collected) => boolean = () => false,
): { pipeline: PlaybackPipeline; got: Collected; done: Promise<void> } {
  const got: Collected = { video: [], audio: [], ended: 0, errors: [] };
  let finish: () => void = () => undefined;
  const done = new Promise<void>((resolve) => (finish = resolve));
  const pipeline = new PlaybackPipeline(config, {
    video: (u) => got.video.push(u),
    audio: (u) => got.audio.push(u),
    isFull: () => isFull(got),
    ended: () => {
      got.ended++;
      finish();
    },
    failed: (err) => {
      got.errors.push(err);
      finish();
    },
  });
  pipeline.start(fromUs);
  return { pipeline, got, done };
}

describe('PlaybackPipeline', () => {
  it('reads both play items in order on one continuous timeline', async () => {
    const { got, done } = run(await setup(), 0);
    await done;
    expect(got.ended).toBe(1);
    expect(got.video).toHaveLength(192);
    const times = got.video.map((u) => u.ptsUs);
    expect(times[0]).toBe(0);
    expect(times[96]).toBe(4_000_000);
    expect(times.every((t, i) => i === 0 || t > times[i - 1])).toBe(true);
    expect(got.video.every((u) => u.inRange)).toBe(true);
    expect(got.audio.length).toBeGreaterThan(1500);
  });

  it('starts from the keyframe before a seek target inside the second item', async () => {
    const { got, done } = run(await setup(), 5_500_000);
    await done;
    expect(got.video[0].ptsUs).toBe(5_000_000);
    expect(got.video.every((u) => u.ptsUs >= 5_000_000)).toBe(true);
  });

  it('waits while the sinks are full and stops cleanly', async () => {
    let blocking = true;
    // Each clip fits in one 2 MB read, so blocking after the first batch pauses between play items.
    const { pipeline, got } = run(await setup(), 0, (g) => blocking && g.video.length > 0);
    await new Promise((r) => setTimeout(r, 30));
    const paused = got.video.length;
    expect(paused).toBeGreaterThan(0);
    expect(paused).toBeLessThan(192);
    expect(got.ended).toBe(0);
    pipeline.stop();
    blocking = false;
    await new Promise((r) => setTimeout(r, 30));
    expect(got.video.length).toBe(paused);
    expect(got.ended).toBe(0);
  });

  it('reports a missing clip through failed()', async () => {
    const config = await setup();
    const first = config.clips.get('00001');
    if (!first) throw new Error('fixture is missing clip 00001');
    const { got, done } = run({ ...config, clips: new Map([['00001', first]]) }, 5_000_000);
    await done;
    expect(got.errors[0]).toBeInstanceOf(DiscError);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/engine/playback`
Expected: FAIL, because the modules cannot be resolved.

- [ ] **Step 4: Implement `stream-selection.ts` and `pipeline.ts`**

`src/engine/playback/stream-selection.ts`:
```ts
import type { StnTable, StreamEntry } from '../bdmv/mpls-parser';
import { CodingType } from '../bdmv/stream-types';

/** Audio coding types this build can decode. M2 adds AC-3 (and the TrueHD AC-3 core). */
export const PLAYABLE_AUDIO: ReadonlySet<number> = new Set([CodingType.LPCM]);

export interface StreamChoice {
  readonly video: StreamEntry | null;
  readonly audio: StreamEntry | null;
  /** Main-path audio streams present but not decodable (empty when `audio` is set). */
  readonly unsupportedAudio: readonly StreamEntry[];
}

export function chooseStreams(stn: StnTable, playableAudio: ReadonlySet<number> = PLAYABLE_AUDIO): StreamChoice {
  const video = stn.video.find((s) => !s.subPath) ?? null;
  const mainAudio = stn.audio.filter((s) => !s.subPath);
  const audio = mainAudio.find((s) => playableAudio.has(s.codingType)) ?? null;
  return { video, audio, unsupportedAudio: audio ? [] : mainAudio };
}
```

`src/engine/playback/pipeline.ts`:
```ts
import { findEpAfter, findEpBefore, type Clpi } from '../bdmv/clpi-parser';
import { DiscError, type ByteSource } from '../disc/byte-source';
import { clipInfoPath, streamPath } from '../disc/open-disc';
import { M2tsReader, type DemuxStats } from '../demux/m2ts-reader';
import type { Timeline } from '../nav/timeline';

export interface PipelineUnit {
  readonly data: Uint8Array;
  /** Playlist time. */
  readonly ptsUs: number;
  /** False when the PTS lies outside the play item's in/out range. */
  readonly inRange: boolean;
}

export interface PipelineSinks {
  video(unit: PipelineUnit): void;
  audio(unit: PipelineUnit): void;
  /** Backpressure: reading pauses while this returns true. */
  isFull(): boolean;
  ended(): void;
  failed(err: unknown): void;
}

export interface PipelineConfig {
  readonly source: ByteSource;
  readonly timeline: Timeline;
  readonly clips: ReadonlyMap<string, Clpi>;
  readonly videoPid: number;
  readonly audioPid: number | null;
}

/** Reads a playlist's clips in order from a start time and feeds access units to the sinks. */
export class PlaybackPipeline {
  private generation = 0;
  private corruptPackets = 0;
  private continuityErrors = 0;

  constructor(
    private readonly config: PipelineConfig,
    private readonly sinks: PipelineSinks,
    private readonly wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  get stats(): DemuxStats {
    return { corruptPackets: this.corruptPackets, continuityErrors: this.continuityErrors };
  }

  start(fromUs: number): void {
    const gen = ++this.generation;
    this.run(gen, fromUs).catch((err: unknown) => {
      if (gen === this.generation) this.sinks.failed(err);
    });
  }

  stop(): void {
    this.generation++;
  }

  private async run(gen: number, fromUs: number): Promise<void> {
    const { source, timeline, clips, videoPid, audioPid } = this.config;
    const pids = new Set([videoPid]);
    if (audioPid !== null) pids.add(audioPid);
    const startPos = timeline.locate(fromUs);

    for (let i = startPos.item.index; i < timeline.items.length; i++) {
      const item = timeline.items[i];
      if (item.outTime <= item.inTime) continue;
      const clip = clips.get(item.clipId);
      if (!clip) throw new DiscError('missing-file', `Missing clip info for ${item.clipId}`, [clipInfoPath(item.clipId)]);
      const ep = clip.epMaps.find((m) => m.pid === videoPid) ?? clip.epMaps[0];
      const target = i === startPos.item.index ? startPos.clipTime45 : item.inTime;
      const startSpn = ep ? (findEpBefore(ep, target)?.spn ?? 0) : 0;
      const endSpn = ep ? findEpAfter(ep, item.outTime)?.spn : undefined;
      const reader = new M2tsReader({ source, path: streamPath(item.clipId), startSpn, endSpn, pids });

      for (;;) {
        while (this.sinks.isFull()) {
          await this.wait(5);
          if (gen !== this.generation) return;
        }
        if (gen !== this.generation) return;
        const batch = await reader.next();
        if (gen !== this.generation) return;
        if (batch === null) break;
        for (const pes of batch) {
          if (gen !== this.generation) return;
          if (pes.pts === undefined) continue;
          const { us, inRange } = timeline.toPlaylistUs(i, pes.pts);
          const unit: PipelineUnit = { data: pes.payload, ptsUs: us, inRange };
          if (pes.pid === videoPid) this.sinks.video(unit);
          else this.sinks.audio(unit);
        }
      }
      this.corruptPackets += reader.stats.corruptPackets;
      this.continuityErrors += reader.stats.continuityErrors;
    }
    if (gen === this.generation) this.sinks.ended();
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/engine/playback && npm run typecheck`
Expected: all pass. The seek test relies on the EP entry at 5.0 s: keyframes fall every 24 frames (1 s), and the second item starts at 4 s.

- [ ] **Step 6: Commit**

```bash
git add src/engine/playback tests/helpers/synthetic-disc.ts
git commit -m "feat(engine): read playlists across play items with EP-map seeking and backpressure"
```

---

### Task 16: Engine protocol, Player orchestrator, and worker entry

**Files:**
- Create: `src/engine/protocol.ts`, `src/engine/player.ts`, `src/engine/worker.ts`
- Test: `src/engine/player.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–15.
- Produces:
  - `type PlaybackState = 'idle' | 'loading' | 'paused' | 'buffering' | 'playing' | 'ended' | 'error'`
  - `type NoticeCode = 'bdj' | 'audio-disabled' | 'decoder-recovered'`
  - `type ErrorCode = DiscErrorCode | 'corrupt-disc' | 'decoder-failed' | 'no-video' | 'internal'`
  - `interface Telemetry { clockUs; clockMode; avOffsetMeanUs; avOffsetMaxAbsUs; framesInWindow; framesPresented; framesDropped; audioBufferedMs; audioUnderruns; corruptPackets; continuityErrors; decoderErrors }`
  - `type EngineCommand`:
    - `open { entries: ReadonlyArray<readonly [string, Blob]> }`
    - `attachCanvas { canvas: OffscreenCanvas }`, `attachAudio { ring: SharedArrayBuffer }`, `resize { width, height }`
    - `playPlaylist { playlistId }`, `play`, `pause`, `seek { timeUs }`, `nextChapter`, `prevChapter`
  - `type EngineEvent`:
    - `titles { playlists, usesBdj, warnings }`, `chapters { playlistId, durationUs, chapters }`
    - `state { state }`, `time { timeUs }`
    - `notice { code, message }`, `unsupported { kind: 'video' | 'audio', codec, message }`, `error { code, message, paths }`
    - `telemetry { telemetry }`
  - `interface PlayerDeps { emit; videoCodecApi; nowMs; requestFrame; createCompositor }`
  - `class Player(deps)` with `handle(cmd): Promise<void>`, and `tick(): void`, which is public for tests. The worker drives it from `requestAnimationFrame`.

Notes:
- **Volume and mute are applied on the main thread** (a `GainNode` in Task 17), so the spec's `setVolume` command never reaches the engine.
- **The A/V offset in telemetry** is `clock − frame.timestamp`, measured when each frame is first drawn while playing. It is the presentation lag of the video against the audio clock. The ±20 ms acceptance criterion applies to its per-window mean.

Playback state machine:
- `playPlaylist`/`seek` → `buffering` (or `paused` if not playing).
- `buffering` → `playing` once ≥ 200 ms of audio is buffered (or the reader is blocked on full video, or input ended) **and** a frame is ready.
- While `playing` with audio: if the ring runs dry while the reader is *not* blocked on video, go back to `buffering`. If the worklet heartbeat stops for 500 ms, disable audio, switch to the wall clock, and emit notice `audio-disabled`.
- `playing` → `ended` when input has ended, the decoder is flushed, the queue is empty, and the clock passes the last frame.

- [ ] **Step 1: Create `src/engine/protocol.ts`**

```ts
import type { ClockMode } from './clock/master-clock';
import type { DiscErrorCode } from './disc/byte-source';
import type { PlaylistSummary } from './disc/open-disc';
import type { Chapter } from './nav/timeline';

export type PlaybackState = 'idle' | 'loading' | 'paused' | 'buffering' | 'playing' | 'ended' | 'error';
export type NoticeCode = 'bdj' | 'audio-disabled' | 'decoder-recovered';
export type ErrorCode = DiscErrorCode | 'corrupt-disc' | 'decoder-failed' | 'no-video' | 'internal';

export interface Telemetry {
  readonly clockUs: number;
  readonly clockMode: ClockMode;
  /** Mean of (clock − frame timestamp) for frames first drawn in this window while playing. */
  readonly avOffsetMeanUs: number | null;
  readonly avOffsetMaxAbsUs: number | null;
  readonly framesInWindow: number;
  readonly framesPresented: number;
  readonly framesDropped: number;
  readonly audioBufferedMs: number;
  readonly audioUnderruns: number;
  readonly corruptPackets: number;
  readonly continuityErrors: number;
  readonly decoderErrors: number;
}

export type EngineCommand =
  | { readonly type: 'open'; readonly entries: ReadonlyArray<readonly [string, Blob]> }
  | { readonly type: 'attachCanvas'; readonly canvas: OffscreenCanvas }
  | { readonly type: 'attachAudio'; readonly ring: SharedArrayBuffer }
  | { readonly type: 'resize'; readonly width: number; readonly height: number }
  | { readonly type: 'playPlaylist'; readonly playlistId: string }
  | { readonly type: 'play' }
  | { readonly type: 'pause' }
  | { readonly type: 'seek'; readonly timeUs: number }
  | { readonly type: 'nextChapter' }
  | { readonly type: 'prevChapter' };

export type EngineEvent =
  | { readonly type: 'titles'; readonly playlists: readonly PlaylistSummary[]; readonly usesBdj: boolean; readonly warnings: readonly string[] }
  | { readonly type: 'chapters'; readonly playlistId: string; readonly durationUs: number; readonly chapters: readonly Chapter[] }
  | { readonly type: 'state'; readonly state: PlaybackState }
  | { readonly type: 'time'; readonly timeUs: number }
  | { readonly type: 'notice'; readonly code: NoticeCode; readonly message: string }
  | { readonly type: 'unsupported'; readonly kind: 'video' | 'audio'; readonly codec: string; readonly message: string }
  | { readonly type: 'error'; readonly code: ErrorCode; readonly message: string; readonly paths: readonly string[] }
  | { readonly type: 'telemetry'; readonly telemetry: Telemetry };
```

- [ ] **Step 2: Write the failing Player tests**

`src/engine/player.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { buildSyntheticDisc, discEntries, syntheticClip } from '../../tests/helpers/synthetic-disc';
import { createRing, renderQuantum, ringViews, type RingViews } from './audio/ring';
import { CodingType } from './bdmv/stream-types';
import type { VideoCodecApi, VideoDecoderLike } from './decode/video-decoder';
import { Player } from './player';
import type { EngineEvent, PlaybackState, Telemetry } from './protocol';

class FakeDecoder implements VideoDecoderLike {
  state: CodecState = 'unconfigured';
  decodeQueueSize = 0;
  constructor(private readonly init: VideoDecoderInit) {}
  configure(): void {
    this.state = 'configured';
  }
  decode(chunk: EncodedVideoChunk): void {
    const { timestamp } = chunk as unknown as EncodedVideoChunkInit;
    this.init.output({ timestamp, displayWidth: 320, displayHeight: 180, close: () => undefined } as unknown as VideoFrame);
  }
  async flush(): Promise<void> {}
  reset(): void {
    this.state = 'unconfigured';
  }
  close(): void {
    this.state = 'closed';
  }
}

const fakeApi: VideoCodecApi = {
  create: (init) => new FakeDecoder(init),
  isConfigSupported: async (config) => ({ supported: true, config }),
  makeChunk: (init) => init as unknown as EncodedVideoChunk,
};

/** 5 render quanta = 640 frames at 48 kHz. */
const STEP_MS = 640 / 48;

interface Harness {
  player: Player;
  events: EngineEvent[];
  drawn: number[];
  /** Advance simulated time; the fake worklet consumes audio unless audio: false; ticks unless render: false. */
  play(ms: number, opts?: { render?: boolean; audio?: boolean }): Promise<void>;
}

async function harness(audio: number | undefined): Promise<Harness> {
  const files = buildSyntheticDisc({
    clips: [syntheticClip('00001', 4, { audio }), syntheticClip('00002', 4, { audio })],
    playlists: [{ id: '00000', clipIds: ['00001', '00002'], chapterEverySeconds: 2 }],
  });
  const events: EngineEvent[] = [];
  const drawn: number[] = [];
  const clock = { ms: 1000 };
  const player = new Player({
    emit: (e) => events.push(e),
    videoCodecApi: fakeApi,
    nowMs: () => clock.ms,
    requestFrame: () => undefined,
    createCompositor: () => ({
      resize: () => undefined,
      drawVideo: (f) => {
        if (f) drawn.push(f.timestamp);
      },
    }),
  });
  const ring = createRing(48_000, 2);
  const views: RingViews = ringViews(ring);
  await player.handle({ type: 'attachAudio', ring });
  await player.handle({ type: 'attachCanvas', canvas: {} as OffscreenCanvas });
  await player.handle({ type: 'open', entries: discEntries(files) });
  const left = new Float32Array(128);
  const right = new Float32Array(128);
  return {
    player,
    events,
    drawn,
    async play(ms, opts = {}) {
      for (let elapsed = 0; elapsed < ms; elapsed += STEP_MS) {
        clock.ms += STEP_MS;
        if (opts.audio !== false) for (let q = 0; q < 5; q++) renderQuantum(views, left, right);
        if (opts.render !== false) player.tick();
        await new Promise((r) => setTimeout(r, 1));
      }
    },
  };
}

const states = (h: Harness): PlaybackState[] => h.events.flatMap((e) => (e.type === 'state' ? [e.state] : []));
const lastState = (h: Harness): PlaybackState | undefined => states(h).at(-1);
const lastTelemetry = (h: Harness): Telemetry | undefined => h.events.flatMap((e) => (e.type === 'telemetry' ? [e.telemetry] : [])).at(-1);

async function untilPlaying(h: Harness): Promise<void> {
  await vi.waitFor(
    async () => {
      await h.play(20);
      expect(lastState(h)).toBe('playing');
    },
    { timeout: 5000 },
  );
}

describe('Player', () => {
  it('opens a disc and lists playlists', async () => {
    const h = await harness(CodingType.LPCM);
    expect(h.events).toContainEqual(
      expect.objectContaining({ type: 'titles', usesBdj: false, playlists: [expect.objectContaining({ id: '00000', durationUs: 8_000_000, chapterCount: 4, playable: true })] }),
    );
  });

  it('reports a folder without BDMV', async () => {
    const events: EngineEvent[] = [];
    const player = new Player({ emit: (e) => events.push(e), videoCodecApi: fakeApi, nowMs: () => 0, requestFrame: () => undefined, createCompositor: () => ({ resize: () => undefined, drawVideo: () => undefined }) });
    await player.handle({ type: 'open', entries: [['Stuff/readme.txt', new Blob(['hi'])]] });
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', code: 'not-bdmv' }));
    expect(events.at(-1)).toEqual({ type: 'state', state: 'error' });
  });

  it('plays on the audio clock, in order, across the play-item boundary', async () => {
    const h = await harness(CodingType.LPCM);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    expect(h.events).toContainEqual({
      type: 'chapters',
      playlistId: '00000',
      durationUs: 8_000_000,
      chapters: [0, 2_000_000, 4_000_000, 6_000_000].map((startUs, index) => ({ index, startUs })),
    });
    await untilPlaying(h);
    h.drawn.length = 0;
    await h.play(5000);
    expect(h.drawn.length).toBeGreaterThan(100);
    expect(h.drawn.every((t, i) => i === 0 || t > h.drawn[i - 1])).toBe(true);
    expect(Math.max(...h.drawn)).toBeGreaterThan(4_500_000);
    const telemetry = lastTelemetry(h);
    expect(telemetry?.clockMode).toBe('audio');
    expect(Math.abs(telemetry?.avOffsetMeanUs ?? Infinity)).toBeLessThanOrEqual(20_000);
  });

  it('applies only the last of several rapid seeks and never draws earlier frames', async () => {
    const h = await harness(CodingType.LPCM);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await Promise.all([
      h.player.handle({ type: 'seek', timeUs: 1_000_000 }),
      h.player.handle({ type: 'seek', timeUs: 6_000_000 }),
      h.player.handle({ type: 'seek', timeUs: 3_000_000 }),
    ]);
    h.drawn.length = 0;
    await untilPlaying(h);
    await h.play(300);
    expect(Math.min(...h.drawn)).toBeGreaterThanOrEqual(2_999_000);
    expect(Math.min(...h.drawn)).toBeLessThan(3_100_000);
  });

  it('plays video on the wall clock when the only audio is unsupported', async () => {
    const h = await harness(CodingType.AC3);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'unsupported', kind: 'audio', codec: 'Dolby Digital (AC-3)' }));
    await untilPlaying(h);
    h.drawn.length = 0;
    await h.play(1000);
    expect(h.drawn.length).toBeGreaterThan(15);
    expect(lastTelemetry(h)?.clockMode).toBe('wall');
  });

  it('keeps reading while rendering is throttled and catches up afterwards', async () => {
    const h = await harness(CodingType.LPCM);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(2500, { render: false });
    h.player.tick();
    const time = h.events.flatMap((e) => (e.type === 'time' ? [e.timeUs] : [])).at(-1) ?? 0;
    expect(time).toBeGreaterThan(2_400_000);
    expect(h.drawn.at(-1) ?? 0).toBeGreaterThan(time - 100_000);
    expect(lastState(h)).toBe('playing');
  });

  it('falls back to the wall clock when the audio output stops running', async () => {
    const h = await harness(CodingType.LPCM);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(1200, { audio: false });
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'notice', code: 'audio-disabled' }));
    expect(lastTelemetry(h)?.clockMode).toBe('wall');
  });

  it('jumps to the next chapter', async () => {
    const h = await harness(CodingType.LPCM);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.player.handle({ type: 'nextChapter' });
    expect(h.events).toContainEqual({ type: 'time', timeUs: 2_000_000 });
  });

  it('reaches the ended state at the end of the playlist', async () => {
    const h = await harness(CodingType.AC3);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(8500);
    expect(lastState(h)).toBe('ended');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/engine/player.test.ts`
Expected: FAIL, because `./player` cannot be resolved.

- [ ] **Step 4: Implement `src/engine/player.ts`**

```ts
import { AudioWriter } from './audio/audio-writer';
import { RingWriter, ringViews } from './audio/ring';
import { codingName, isVideoCoding } from './bdmv/stream-types';
import { MasterClock } from './clock/master-clock';
import { Decimator } from './decode/decimator';
import { UnsupportedCodecError, type DecoderError } from './decode/decoder';
import { decodeLpcm, type PcmChunk } from './decode/lpcm';
import { WebCodecsVideoDecoder, hasSps, type VideoCodecApi, type VideoUnit } from './decode/video-decoder';
import { DiscError } from './disc/byte-source';
import { FileSource } from './disc/file-source';
import { checkStreamReadable, loadClips, openDisc, playlistPath, type DiscModel } from './disc/open-disc';
import { normalizeDiscPaths } from './disc/paths';
import { Timeline, type Chapter } from './nav/timeline';
import { PlaybackPipeline, type PipelineUnit } from './playback/pipeline';
import { chooseStreams } from './playback/stream-selection';
import type { EngineCommand, EngineEvent, NoticeCode, PlaybackState } from './protocol';
import type { CompositorLike } from './render/compositor';
import { VideoPresenter } from './render/video-presenter';
import { ParseError } from './util/byte-reader';

export interface PlayerDeps {
  emit(event: EngineEvent): void;
  readonly videoCodecApi: VideoCodecApi;
  nowMs(): number;
  requestFrame(callback: () => void): void;
  createCompositor(canvas: OffscreenCanvas): CompositorLike;
}

const OUTPUT_SAMPLE_RATE = 48_000;
const MAX_QUEUED_FRAMES = 8;
const MAX_DECODE_QUEUE = 8;
const MAX_PENDING_VIDEO = 64;
const AUDIO_PREBUFFER_US = 200_000;
const TIME_EVENT_INTERVAL_US = 250_000;
const TELEMETRY_INTERVAL_MS = 500;
const HEARTBEAT_TIMEOUT_MS = 500;
/** Frames up to this far before a seek target are still shown (EP pts are truncated by up to ~5.7 ms). */
const SEEK_TOLERANCE_US = 1_000;
const NEXT_CHAPTER_GUARD_US = 500_000;
const PREV_CHAPTER_RESTART_US = 3_000_000;

interface Session {
  readonly playlistId: string;
  readonly timeline: Timeline;
  readonly chapters: readonly Chapter[];
  readonly videoCodingType: number;
  readonly decoder: WebCodecsVideoDecoder;
  readonly pipeline: PlaybackPipeline;
  audioActive: boolean;
  decimator: Decimator | null;
  videoState: 'unconfigured' | 'configuring' | 'configured' | 'failed';
  pendingVideo: VideoUnit[];
  dropBeforeUs: number;
  eof: boolean;
  flushed: boolean;
}

/** Owns one disc and at most one playing playlist. Runs inside the engine worker. */
export class Player {
  private source: FileSource | null = null;
  private disc: DiscModel | null = null;
  private session: Session | null = null;
  private state: PlaybackState = 'idle';
  private wantPlaying = false;
  private ring: RingWriter | null = null;
  private audioWriter: AudioWriter | null = null;
  private compositor: CompositorLike | null = null;
  private readonly presenter = new VideoPresenter<VideoFrame>();
  private readonly clock: MasterClock;
  private seekGeneration = 0;
  private renderLoopStarted = false;
  private lastTimeEmitted = Number.NEGATIVE_INFINITY;
  private lastTelemetryMs = Number.NEGATIVE_INFINITY;
  private lastHeartbeat = -1;
  private lastHeartbeatChangeMs = 0;
  private decoderErrors = 0;
  private offsets: number[] = [];

  constructor(private readonly deps: PlayerDeps) {
    this.clock = new MasterClock(deps.nowMs);
  }

  async handle(cmd: EngineCommand): Promise<void> {
    try {
      switch (cmd.type) {
        case 'open':
          await this.open(cmd.entries);
          break;
        case 'attachCanvas':
          this.compositor = this.deps.createCompositor(cmd.canvas);
          this.startRenderLoop();
          break;
        case 'attachAudio':
          this.ring = new RingWriter(ringViews(cmd.ring));
          this.audioWriter = new AudioWriter(this.ring);
          break;
        case 'resize':
          this.compositor?.resize(cmd.width, cmd.height);
          this.compositor?.drawVideo(this.presenter.current);
          break;
        case 'playPlaylist':
          await this.playPlaylist(cmd.playlistId);
          break;
        case 'play':
          this.play();
          break;
        case 'pause':
          this.pause();
          break;
        case 'seek':
          await this.startAt(cmd.timeUs, this.wantPlaying);
          break;
        case 'nextChapter':
          await this.skipChapter(1);
          break;
        case 'prevChapter':
          await this.skipChapter(-1);
          break;
      }
    } catch (err) {
      this.fail(err);
    }
  }

  /** One render tick (requestAnimationFrame in the worker; called directly by tests). */
  tick(): void {
    const s = this.session;
    if (!s) return;
    this.updatePlayback(s);
    const now = this.clock.nowUs();
    const frame = this.presenter.select(now);
    if (frame) {
      this.compositor?.drawVideo(frame);
      if (this.state === 'playing') this.offsets.push(now - frame.timestamp);
    }
    const last = this.presenter.current;
    if (this.state === 'playing' && s.flushed && this.presenter.size === 0 && now >= (last?.timestamp ?? 0) + 100_000) {
      this.wantPlaying = false;
      this.ring?.setPlaying(false);
      this.clock.setRunning(false);
      this.setState('ended');
    }
    this.emitTime(Math.min(now, s.timeline.durationUs), false);
    this.maybeEmitTelemetry(s);
  }

  private startRenderLoop(): void {
    if (this.renderLoopStarted) return;
    this.renderLoopStarted = true;
    const loop = (): void => {
      this.tick();
      this.deps.requestFrame(loop);
    };
    this.deps.requestFrame(loop);
  }

  private async open(entries: ReadonlyArray<readonly [string, Blob]>): Promise<void> {
    this.teardownSession();
    this.setState('loading');
    const source = new FileSource(normalizeDiscPaths(entries));
    const disc = await openDisc(source);
    this.source = source;
    this.disc = disc;
    this.deps.emit({ type: 'titles', playlists: disc.summaries, usesBdj: disc.usesBdj, warnings: disc.warnings });
    if (disc.usesBdj) this.notice('bdj', 'This disc uses BD-J (Java) menus, which are not supported. Choose a playlist to play.');
    this.setState('idle');
  }

  private async playPlaylist(playlistId: string): Promise<void> {
    const source = this.source;
    const mpls = this.disc?.playlists.get(playlistId);
    if (!source || !mpls || mpls.playItems.length === 0) {
      throw new DiscError('missing-file', `Playlist ${playlistId} is not available.`, [playlistPath(playlistId)]);
    }
    this.teardownSession();
    this.setState('loading');
    const clipIds = [...new Set(mpls.playItems.map((p) => p.clipId))];
    const clips = await loadClips(source, clipIds);
    await checkStreamReadable(source, clipIds[0]);

    const choice = chooseStreams(mpls.playItems[0].stn);
    if (!choice.video) {
      this.deps.emit({ type: 'error', code: 'no-video', message: 'This playlist has no video stream.', paths: [] });
      this.setState('error');
      return;
    }
    if (!choice.audio && choice.unsupportedAudio.length > 0) {
      const codec = [...new Set(choice.unsupportedAudio.map((a) => codingName(a.codingType)))].join(', ');
      this.deps.emit({ type: 'unsupported', kind: 'audio', codec, message: `This playlist's audio (${codec}) can't be played yet, so video will play without sound.` });
    }
    const audioActive = choice.audio !== null && this.ring !== null;
    if (choice.audio && !this.ring) this.notice('audio-disabled', 'Audio output is not available, so video will play without sound.');

    const timeline = new Timeline(mpls.playItems);
    const decoder = new WebCodecsVideoDecoder(this.deps.videoCodecApi);
    const ref: { current: Session | null } = { current: null };
    const pipeline = new PlaybackPipeline(
      { source, timeline, clips, videoPid: choice.video.pid, audioPid: audioActive && choice.audio ? choice.audio.pid : null },
      {
        video: (u) => {
          if (ref.current) this.onVideoUnit(ref.current, u);
        },
        audio: (u) => {
          if (ref.current) this.onAudioUnit(ref.current, u);
        },
        isFull: () => ref.current !== null && this.isFull(ref.current),
        ended: () => {
          if (ref.current) this.onPipelineEnded(ref.current);
        },
        failed: (err) => {
          if (ref.current && ref.current === this.session) this.fail(err);
        },
      },
    );
    const session: Session = {
      playlistId,
      timeline,
      chapters: timeline.chapters(mpls.marks),
      videoCodingType: choice.video.codingType,
      decoder,
      pipeline,
      audioActive,
      decimator: null,
      videoState: 'unconfigured',
      pendingVideo: [],
      dropBeforeUs: 0,
      eof: false,
      flushed: false,
    };
    ref.current = session;
    decoder.onOutput = (frame) => {
      if (this.session === session) this.presenter.push(frame);
      else frame.close();
    };
    decoder.onError = (err) => this.onDecoderError(session, err);
    this.session = session;
    this.deps.emit({ type: 'chapters', playlistId, durationUs: timeline.durationUs, chapters: session.chapters });
    await this.startAt(0, true);
  }

  private teardownSession(): void {
    const s = this.session;
    if (!s) return;
    this.session = null;
    this.seekGeneration++;
    s.pipeline.stop();
    s.decoder.close();
    this.presenter.clear();
    this.ring?.setPlaying(false);
    this.compositor?.drawVideo(null);
    this.wantPlaying = false;
  }

  private async startAt(targetUs: number, autoplay: boolean): Promise<void> {
    const s = this.session;
    if (!s) return;
    const gen = ++this.seekGeneration;
    const t = Math.min(Math.max(0, targetUs), Math.max(0, s.timeline.durationUs - 1));
    s.pipeline.stop();
    if (s.videoState === 'configured') s.decoder.reset();
    s.pendingVideo = [];
    s.decimator?.reset();
    s.eof = false;
    s.flushed = false;
    s.dropBeforeUs = t - SEEK_TOLERANCE_US;
    this.presenter.clear();
    this.offsets = [];
    this.wantPlaying = autoplay;
    this.setState(autoplay ? 'buffering' : 'paused');

    const ring = this.ring;
    if (s.audioActive && ring && this.audioWriter) {
      ring.setPlaying(false);
      await ring.requestDiscard();
      if (gen !== this.seekGeneration) return;
      this.clock.useAudio(ring, t);
      this.audioWriter.start(t);
    } else {
      this.clock.useWall(t, false);
    }
    this.emitTime(t, true);
    s.pipeline.start(t);
  }

  private play(): void {
    if (!this.session) return;
    if (this.state === 'ended') {
      void this.startAt(0, true).catch((err: unknown) => this.fail(err));
      return;
    }
    this.wantPlaying = true;
    if (this.state === 'paused') this.setState('buffering');
  }

  private pause(): void {
    if (!this.session) return;
    this.wantPlaying = false;
    this.ring?.setPlaying(false);
    this.clock.setRunning(false);
    if (this.state === 'playing' || this.state === 'buffering') this.setState('paused');
  }

  private async skipChapter(direction: 1 | -1): Promise<void> {
    const s = this.session;
    if (!s || s.chapters.length === 0) return;
    const now = this.clock.nowUs();
    let target: number | undefined;
    if (direction > 0) {
      target = s.chapters.find((c) => c.startUs > now + NEXT_CHAPTER_GUARD_US)?.startUs;
    } else {
      target = [...s.chapters].reverse().find((c) => c.startUs < now - PREV_CHAPTER_RESTART_US)?.startUs ?? 0;
    }
    if (target !== undefined) await this.startAt(target, this.wantPlaying);
  }

  private onVideoUnit(s: Session, u: PipelineUnit): void {
    const unit: VideoUnit = { data: u.data, ptsUs: u.ptsUs, discard: !u.inRange || u.ptsUs < s.dropBeforeUs };
    switch (s.videoState) {
      case 'configured':
        s.decoder.decode(unit);
        return;
      case 'failed':
        return;
      case 'configuring':
        s.pendingVideo.push(unit);
        return;
      case 'unconfigured':
        if (!hasSps(s.videoCodingType, u.data)) return;
        s.videoState = 'configuring';
        s.pendingVideo.push(unit);
        s.decoder.configure({ codingType: s.videoCodingType, firstUnit: u.data }).then(
          () => {
            if (this.session !== s) return;
            s.videoState = 'configured';
            const pending = s.pendingVideo;
            s.pendingVideo = [];
            for (const p of pending) s.decoder.decode(p);
          },
          (err: unknown) => {
            if (this.session !== s) return;
            s.videoState = 'failed';
            this.fail(err);
          },
        );
    }
  }

  private onAudioUnit(s: Session, u: PipelineUnit): void {
    const writer = this.audioWriter;
    if (!s.audioActive || !writer || !u.inRange) return;
    let chunk: PcmChunk;
    try {
      chunk = decodeLpcm(u.data, u.ptsUs);
    } catch (err) {
      if (err instanceof UnsupportedCodecError) {
        this.deps.emit({ type: 'unsupported', kind: 'audio', codec: codingName(err.codingType), message: err.message });
      }
      this.disableAudio(s, `Audio could not be decoded (${err instanceof Error ? err.message : String(err)}), so playback continues without sound.`);
      return;
    }
    if (chunk.sampleRate !== OUTPUT_SAMPLE_RATE) {
      const factor = chunk.sampleRate / OUTPUT_SAMPLE_RATE;
      if (!s.decimator || s.decimator.factor !== factor) s.decimator = new Decimator(factor);
      chunk = s.decimator.process(chunk);
    }
    writer.enqueue(chunk);
  }

  private isFull(s: Session): boolean {
    // Rendering can be throttled (background tab); drop late frames here so reading never stalls on them.
    if (this.state === 'playing') this.presenter.dropLate(this.clock.nowUs());
    this.audioWriter?.drain();
    return (
      this.videoBlocked(s) ||
      s.pendingVideo.length >= MAX_PENDING_VIDEO ||
      (s.audioActive && (this.audioWriter?.queuedChunks ?? 0) > 0)
    );
  }

  private videoBlocked(s: Session): boolean {
    return this.presenter.size >= MAX_QUEUED_FRAMES || s.decoder.queueSize >= MAX_DECODE_QUEUE;
  }

  private onPipelineEnded(s: Session): void {
    s.eof = true;
    if (s.videoState !== 'configured') {
      s.flushed = true;
      return;
    }
    void s.decoder.flush().then(() => {
      if (this.session === s) s.flushed = true;
    });
  }

  private onDecoderError(s: Session, err: DecoderError): void {
    if (this.session !== s) return;
    this.decoderErrors++;
    if (!err.fatal) {
      this.notice('decoder-recovered', err.message);
      return;
    }
    s.videoState = 'failed';
    this.deps.emit({ type: 'error', code: 'decoder-failed', message: err.message, paths: [] });
    this.pause();
    this.setState('error');
  }

  private updatePlayback(s: Session): void {
    const ring = s.audioActive ? this.ring : null;
    if (this.state === 'buffering' && this.wantPlaying) {
      const audioReady =
        !ring ||
        s.eof ||
        this.videoBlocked(s) ||
        (this.audioWriter?.queuedChunks ?? 0) > 0 ||
        (ring.buffered() * 1e6) / ring.sampleRate >= AUDIO_PREBUFFER_US;
      const videoReady = this.presenter.size > 0 || this.presenter.current !== null || s.eof || s.videoState === 'failed';
      if (!audioReady || !videoReady) return;
      if (ring) {
        ring.setPlaying(true);
        this.lastHeartbeat = ring.heartbeat();
        this.lastHeartbeatChangeMs = this.deps.nowMs();
      } else {
        this.clock.setRunning(true);
      }
      this.setState('playing');
      return;
    }
    if (this.state !== 'playing' || !ring) return;

    const beat = ring.heartbeat();
    const nowMs = this.deps.nowMs();
    if (beat !== this.lastHeartbeat) {
      this.lastHeartbeat = beat;
      this.lastHeartbeatChangeMs = nowMs;
    } else if (nowMs - this.lastHeartbeatChangeMs > HEARTBEAT_TIMEOUT_MS) {
      this.disableAudio(s, 'Audio output is not running (the browser may have blocked it), so playback continues without sound.');
      return;
    }
    if (!s.eof && ring.buffered() === 0 && !this.videoBlocked(s)) {
      ring.setPlaying(false);
      this.setState('buffering');
    }
  }

  private disableAudio(s: Session, message: string): void {
    if (!s.audioActive) return;
    const now = this.clock.nowUs();
    s.audioActive = false;
    this.ring?.setPlaying(false);
    this.clock.useWall(now, this.state === 'playing');
    this.notice('audio-disabled', message);
  }

  private emitTime(timeUs: number, force: boolean): void {
    if (!force && Math.abs(timeUs - this.lastTimeEmitted) < TIME_EVENT_INTERVAL_US) return;
    this.lastTimeEmitted = timeUs;
    this.deps.emit({ type: 'time', timeUs: Math.round(timeUs) });
  }

  private maybeEmitTelemetry(s: Session): void {
    const nowMs = this.deps.nowMs();
    if (nowMs - this.lastTelemetryMs < TELEMETRY_INTERVAL_MS) return;
    this.lastTelemetryMs = nowMs;
    const offsets = this.offsets;
    this.offsets = [];
    const ring = this.ring;
    const stats = s.pipeline.stats;
    this.deps.emit({
      type: 'telemetry',
      telemetry: {
        clockUs: this.clock.nowUs(),
        clockMode: this.clock.mode,
        avOffsetMeanUs: offsets.length > 0 ? offsets.reduce((a, b) => a + b, 0) / offsets.length : null,
        avOffsetMaxAbsUs: offsets.length > 0 ? Math.max(...offsets.map((o) => Math.abs(o))) : null,
        framesInWindow: offsets.length,
        framesPresented: this.presenter.presented,
        framesDropped: this.presenter.dropped,
        audioBufferedMs: ring ? (ring.buffered() * 1000) / ring.sampleRate : 0,
        audioUnderruns: ring?.underruns() ?? 0,
        corruptPackets: stats.corruptPackets,
        continuityErrors: stats.continuityErrors,
        decoderErrors: this.decoderErrors,
      },
    });
  }

  private notice(code: NoticeCode, message: string): void {
    this.deps.emit({ type: 'notice', code, message });
  }

  private setState(state: PlaybackState): void {
    if (state === this.state) return;
    this.state = state;
    this.deps.emit({ type: 'state', state });
  }

  private fail(err: unknown): void {
    if (err instanceof DiscError) {
      this.deps.emit({ type: 'error', code: err.code, message: err.message, paths: err.paths });
    } else if (err instanceof UnsupportedCodecError) {
      this.deps.emit({ type: 'unsupported', kind: isVideoCoding(err.codingType) ? 'video' : 'audio', codec: codingName(err.codingType), message: err.message });
    } else if (err instanceof ParseError) {
      this.deps.emit({ type: 'error', code: 'corrupt-disc', message: `The disc data is damaged: ${err.message}`, paths: [] });
    } else {
      this.deps.emit({ type: 'error', code: 'internal', message: err instanceof Error ? err.message : String(err), paths: [] });
    }
    this.session?.pipeline.stop();
    this.wantPlaying = false;
    this.ring?.setPlaying(false);
    this.clock.setRunning(false);
    this.setState('error');
  }
}
```

- [ ] **Step 5: Create `src/engine/worker.ts`**

```ts
import { browserVideoCodecApi } from './decode/video-decoder';
import { Player } from './player';
import type { EngineCommand, EngineEvent } from './protocol';
import { Compositor } from './render/compositor';

interface WorkerScope {
  postMessage(message: EngineEvent): void;
  onmessage: ((event: MessageEvent<EngineCommand>) => void) | null;
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
}

const scope = self as unknown as WorkerScope;

const player = new Player({
  emit: (event) => scope.postMessage(event),
  videoCodecApi: browserVideoCodecApi,
  nowMs: () => performance.now(),
  requestFrame: (callback) => {
    if (scope.requestAnimationFrame) scope.requestAnimationFrame(() => callback());
    else setTimeout(callback, 16);
  },
  createCompositor: (canvas) => new Compositor(canvas),
});

scope.onmessage = (event) => {
  void player.handle(event.data);
};
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/engine/player.test.ts && npm test && npm run typecheck`
Expected: Player tests pass (they take a few seconds of real time; each seek waits ≤ 100 ms for the ring discard fallback). The full unit suite passes.

If "plays on the audio clock" flakes with `buffering` flapping, look at the starvation check in `updatePlayback`. It must not fire while `videoBlocked(s)` is true.

- [ ] **Step 7: Commit**

```bash
git add src/engine/protocol.ts src/engine/player.ts src/engine/player.test.ts src/engine/worker.ts
git commit -m "feat(engine): orchestrate playback sessions with audio-master sync, seeking and fallbacks"
```

---

### Task 17: Main-thread audio output, AudioWorklet, and PlayerController

**Files:**
- Create: `src/player/pcm-worklet.ts`, `src/player/audio-output.ts`, `src/player/player-controller.ts`, `src/player/create-controller.ts`
- Test: `src/player/player-controller.test.ts`

**Interfaces:**
- Consumes: `EngineCommand`, `EngineEvent`, `PlaybackState`, `Telemetry`, `ErrorCode` (Task 16); `createRing`, `ringViews`, `renderQuantum`, `Control` (Task 12); `PlaylistSummary`; `Chapter`.
- Produces:
  - `interface Notice { code; message }`
  - `interface PlayerSnapshot { engineState; playlists; usesBdj; warnings; currentPlaylistId; durationUs; timeUs; chapters; notices; error; telemetry; volume; muted }`
  - `INITIAL_SNAPSHOT`; `reduceEvent(snapshot, event): PlayerSnapshot`
  - `interface WorkerLike`, `interface AudioOutputLike { ensureStarted(): Promise<SharedArrayBuffer>; setVolume(v); setMuted(m) }`
  - `class PlayerController(worker, audio)` with:
    - store access: `subscribe`, `getSnapshot` (stable arrow properties for `useSyncExternalStore`)
    - wiring: `attachCanvas(canvas)` (transfers each canvas once), `resize(w, h)`, `startAudio()`, `open(entries)`
    - playback: `playPlaylist(id)`, `play()`, `pause()`, `togglePlay()`, `seek(us)`, `seekBy(deltaUs)`, `nextChapter()`, `prevChapter()`
    - volume and notices: `setVolume(v)`, `toggleMute()`, `dismissNotice(code)`, `closeDisc()`
  - `class AudioOutput implements AudioOutputLike` (48 kHz `AudioContext`, worklet `pcm-player`, gain node; publishes output latency into the ring every 500 ms)
  - `createController(): PlayerController`. With `?telemetry` in the URL, it mirrors telemetry to `window.__blurayTelemetry` for E2E.

The `AudioContext` must be created inside a user gesture, so every click handler that can start playback calls `controller.startAudio()` first. That method is idempotent.

- [ ] **Step 1: Write the failing tests**

`src/player/player-controller.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '../engine/protocol';
import { INITIAL_SNAPSHOT, PlayerController, reduceEvent, type AudioOutputLike, type WorkerLike } from './player-controller';

class FakeWorker implements WorkerLike {
  readonly posted: unknown[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  emit(event: EngineEvent): void {
    this.onmessage?.({ data: event } as MessageEvent);
  }
}

class FakeAudio implements AudioOutputLike {
  volume = 1;
  muted = false;
  starts = 0;
  readonly ring = new SharedArrayBuffer(8);
  fail = false;
  ensureStarted(): Promise<SharedArrayBuffer> {
    this.starts++;
    return this.fail ? Promise.reject(new Error('no audio device')) : Promise.resolve(this.ring);
  }
  setVolume(v: number): void {
    this.volume = v;
  }
  setMuted(m: boolean): void {
    this.muted = m;
  }
}

const summary = { id: '00000', durationUs: 8_000_000, chapterCount: 4, clipIds: ['00001'], playable: true, missingPaths: [] };

describe('reduceEvent', () => {
  it('tracks titles, chapters, state and time', () => {
    let s = reduceEvent(INITIAL_SNAPSHOT, { type: 'titles', playlists: [summary], usesBdj: false, warnings: [] });
    s = reduceEvent(s, { type: 'chapters', playlistId: '00000', durationUs: 8_000_000, chapters: [{ index: 0, startUs: 0 }] });
    s = reduceEvent(s, { type: 'state', state: 'playing' });
    s = reduceEvent(s, { type: 'time', timeUs: 1_500_000 });
    expect(s).toMatchObject({ playlists: [summary], currentPlaylistId: '00000', durationUs: 8_000_000, engineState: 'playing', timeUs: 1_500_000 });
  });

  it('dedupes notices by code and records unsupported streams and errors', () => {
    let s = reduceEvent(INITIAL_SNAPSHOT, { type: 'notice', code: 'audio-disabled', message: 'a' });
    s = reduceEvent(s, { type: 'notice', code: 'audio-disabled', message: 'b' });
    s = reduceEvent(s, { type: 'unsupported', kind: 'audio', codec: 'DTS', message: 'no DTS' });
    s = reduceEvent(s, { type: 'error', code: 'not-bdmv', message: 'nope', paths: ['BDMV/INDEX.BDMV'] });
    expect(s.notices).toEqual([
      { code: 'audio-disabled', message: 'b' },
      { code: 'unsupported-audio', message: 'no DTS' },
    ]);
    expect(s.error).toEqual({ code: 'not-bdmv', message: 'nope', paths: ['BDMV/INDEX.BDMV'] });
  });
});

describe('PlayerController', () => {
  it('starts audio and attaches the ring once, then opens the disc', async () => {
    const worker = new FakeWorker();
    const audio = new FakeAudio();
    const c = new PlayerController(worker, audio);
    const file = new File(['x'], 'index.bdmv');
    c.open([['Disc/BDMV/index.bdmv', file]]);
    c.play();
    await Promise.resolve();
    await Promise.resolve();
    expect(worker.posted).toEqual([
      { type: 'open', entries: [['Disc/BDMV/index.bdmv', file]] },
      { type: 'play' },
      { type: 'attachAudio', ring: audio.ring },
    ]);
    expect(audio.starts).toBe(2);
  });

  it('notifies subscribers with new snapshots from worker events', () => {
    const worker = new FakeWorker();
    const c = new PlayerController(worker, new FakeAudio());
    let calls = 0;
    const unsubscribe = c.subscribe(() => calls++);
    const before = c.getSnapshot();
    worker.emit({ type: 'state', state: 'buffering' });
    expect(calls).toBe(1);
    expect(c.getSnapshot()).not.toBe(before);
    expect(c.getSnapshot().engineState).toBe('buffering');
    unsubscribe();
    worker.emit({ type: 'state', state: 'playing' });
    expect(calls).toBe(1);
  });

  it('toggles play/pause based on engine state and clamps seeks and volume', () => {
    const worker = new FakeWorker();
    const audio = new FakeAudio();
    const c = new PlayerController(worker, audio);
    worker.emit({ type: 'chapters', playlistId: '00000', durationUs: 8_000_000, chapters: [] });
    worker.emit({ type: 'state', state: 'playing' });
    worker.emit({ type: 'time', timeUs: 7_000_000 });
    worker.posted.length = 0;
    c.togglePlay();
    c.seekBy(10_000_000);
    c.seek(-5);
    c.setVolume(1.7);
    c.toggleMute();
    expect(worker.posted).toEqual([{ type: 'pause' }, { type: 'seek', timeUs: 8_000_000 }, { type: 'seek', timeUs: 0 }]);
    expect(audio.volume).toBe(1);
    expect(audio.muted).toBe(true);
    expect(c.getSnapshot()).toMatchObject({ volume: 1, muted: true });
  });

  it('adds a notice when audio cannot start', async () => {
    const audio = new FakeAudio();
    audio.fail = true;
    const c = new PlayerController(new FakeWorker(), audio);
    c.startAudio();
    await new Promise((r) => setTimeout(r, 0));
    expect(c.getSnapshot().notices).toEqual([{ code: 'audio-output', message: 'Audio output could not start: no audio device' }]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/player`
Expected: FAIL, because `./player-controller` cannot be resolved.

- [ ] **Step 3: Implement `src/player/player-controller.ts`**

```ts
import type { PlaylistSummary } from '../engine/disc/open-disc';
import type { Chapter } from '../engine/nav/timeline';
import type { EngineCommand, EngineEvent, ErrorCode, PlaybackState, Telemetry } from '../engine/protocol';

export interface Notice {
  readonly code: string;
  readonly message: string;
}

export interface PlayerSnapshot {
  readonly engineState: PlaybackState;
  readonly playlists: readonly PlaylistSummary[];
  readonly usesBdj: boolean;
  readonly warnings: readonly string[];
  readonly currentPlaylistId: string | null;
  readonly durationUs: number;
  readonly timeUs: number;
  readonly chapters: readonly Chapter[];
  readonly notices: readonly Notice[];
  readonly error: { readonly code: ErrorCode; readonly message: string; readonly paths: readonly string[] } | null;
  readonly telemetry: Telemetry | null;
  readonly volume: number;
  readonly muted: boolean;
}

export const INITIAL_SNAPSHOT: PlayerSnapshot = {
  engineState: 'idle',
  playlists: [],
  usesBdj: false,
  warnings: [],
  currentPlaylistId: null,
  durationUs: 0,
  timeUs: 0,
  chapters: [],
  notices: [],
  error: null,
  telemetry: null,
  volume: 1,
  muted: false,
};

function withNotice(s: PlayerSnapshot, notice: Notice): PlayerSnapshot {
  return { ...s, notices: [...s.notices.filter((n) => n.code !== notice.code), notice] };
}

export function reduceEvent(s: PlayerSnapshot, e: EngineEvent): PlayerSnapshot {
  switch (e.type) {
    case 'titles':
      return { ...s, playlists: e.playlists, usesBdj: e.usesBdj, warnings: e.warnings, error: null, currentPlaylistId: null, chapters: [], durationUs: 0, timeUs: 0 };
    case 'chapters':
      return { ...s, currentPlaylistId: e.playlistId, durationUs: e.durationUs, chapters: e.chapters, timeUs: 0, error: null };
    case 'state':
      return { ...s, engineState: e.state };
    case 'time':
      return { ...s, timeUs: e.timeUs };
    case 'notice':
      return withNotice(s, { code: e.code, message: e.message });
    case 'unsupported':
      return withNotice(s, { code: `unsupported-${e.kind}`, message: e.message });
    case 'error':
      return { ...s, error: { code: e.code, message: e.message, paths: e.paths } };
    case 'telemetry':
      return { ...s, telemetry: e.telemetry };
  }
}

export interface WorkerLike {
  postMessage(message: unknown, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

export interface AudioOutputLike {
  ensureStarted(): Promise<SharedArrayBuffer>;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
}

/** Main-thread facade over the engine worker; an external store for React. */
export class PlayerController {
  private snapshot: PlayerSnapshot = INITIAL_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private audioAttached = false;
  private readonly transferredCanvases = new WeakSet<HTMLCanvasElement>();

  constructor(
    private readonly worker: WorkerLike,
    private readonly audio: AudioOutputLike,
  ) {
    worker.onmessage = (event: MessageEvent<EngineEvent>) => this.update(reduceEvent(this.snapshot, event.data));
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): PlayerSnapshot => this.snapshot;

  /** Each canvas can be transferred only once (React StrictMode runs effects twice); a remounted screen brings a new one. */
  attachCanvas(canvas: HTMLCanvasElement): void {
    if (this.transferredCanvases.has(canvas)) return;
    this.transferredCanvases.add(canvas);
    const offscreen = canvas.transferControlToOffscreen();
    this.post({ type: 'attachCanvas', canvas: offscreen }, [offscreen]);
  }

  resize(width: number, height: number): void {
    this.post({ type: 'resize', width, height });
  }

  /** Call from user-gesture handlers so the AudioContext is allowed to start. */
  startAudio(): void {
    this.audio.ensureStarted().then(
      (ring) => {
        if (this.audioAttached) return;
        this.audioAttached = true;
        this.post({ type: 'attachAudio', ring });
      },
      (err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        this.update(withNotice(this.snapshot, { code: 'audio-output', message: `Audio output could not start: ${reason}` }));
      },
    );
  }

  open(entries: ReadonlyArray<readonly [string, File]>): void {
    this.startAudio();
    this.update({ ...INITIAL_SNAPSHOT, volume: this.snapshot.volume, muted: this.snapshot.muted, engineState: 'loading' });
    this.post({ type: 'open', entries });
  }

  playPlaylist(playlistId: string): void {
    this.startAudio();
    this.post({ type: 'playPlaylist', playlistId });
  }

  play(): void {
    this.startAudio();
    this.post({ type: 'play' });
  }

  pause(): void {
    this.post({ type: 'pause' });
  }

  togglePlay(): void {
    const state = this.snapshot.engineState;
    if (state === 'playing' || state === 'buffering') this.pause();
    else this.play();
  }

  seek(timeUs: number): void {
    this.post({ type: 'seek', timeUs: Math.min(Math.max(0, timeUs), this.snapshot.durationUs) });
  }

  seekBy(deltaUs: number): void {
    this.seek(this.snapshot.timeUs + deltaUs);
  }

  nextChapter(): void {
    this.post({ type: 'nextChapter' });
  }

  prevChapter(): void {
    this.post({ type: 'prevChapter' });
  }

  setVolume(volume: number): void {
    const v = Math.min(Math.max(0, volume), 1);
    this.audio.setVolume(v);
    this.update({ ...this.snapshot, volume: v });
  }

  toggleMute(): void {
    const muted = !this.snapshot.muted;
    this.audio.setMuted(muted);
    this.update({ ...this.snapshot, muted });
  }

  dismissNotice(code: string): void {
    this.update({ ...this.snapshot, notices: this.snapshot.notices.filter((n) => n.code !== code) });
  }

  closeDisc(): void {
    this.pause();
    this.update({ ...INITIAL_SNAPSHOT, volume: this.snapshot.volume, muted: this.snapshot.muted });
  }

  private post(cmd: EngineCommand, transfer: Transferable[] = []): void {
    this.worker.postMessage(cmd, transfer);
  }

  private update(next: PlayerSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/player`
Expected: 6 passed.

- [ ] **Step 5: Implement the worklet, audio output, and browser wiring** (these run only in a browser and are verified by E2E in Task 20)

`src/player/pcm-worklet.ts`:
```ts
import { renderQuantum, ringViews, type RingViews } from '../engine/audio/ring';

interface PcmPlayerOptions {
  processorOptions: { ring: SharedArrayBuffer };
}

// AudioWorkletGlobalScope globals (not in lib.dom).
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processorCtor: new (options: PcmPlayerOptions) => AudioWorkletProcessor): void;

class PcmPlayer extends AudioWorkletProcessor {
  private readonly views: RingViews;

  constructor(options: PcmPlayerOptions) {
    super();
    this.views = ringViews(options.processorOptions.ring);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const [left, right] = outputs[0];
    renderQuantum(this.views, left, right);
    return true;
  }
}

registerProcessor('pcm-player', PcmPlayer);
```

`src/player/audio-output.ts`:
```ts
import { Control, createRing, ringViews } from '../engine/audio/ring';
import type { AudioOutputLike } from './player-controller';
import workletUrl from './pcm-worklet.ts?worker&url';

export const OUTPUT_SAMPLE_RATE = 48_000;
const RING_SECONDS = 2;

/** 48 kHz stereo AudioContext playing from the shared ring through a gain node. */
export class AudioOutput implements AudioOutputLike {
  private started: { context: AudioContext; ready: Promise<SharedArrayBuffer> } | null = null;
  private gain: GainNode | null = null;
  private volume = 1;
  private muted = false;

  ensureStarted(): Promise<SharedArrayBuffer> {
    if (!this.started) {
      const context = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE, latencyHint: 'playback' });
      this.started = { context, ready: this.setUp(context) };
    }
    void this.started.context.resume();
    return this.started.ready;
  }

  setVolume(volume: number): void {
    this.volume = volume;
    this.applyGain();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyGain();
  }

  private async setUp(context: AudioContext): Promise<SharedArrayBuffer> {
    await context.audioWorklet.addModule(workletUrl);
    const ring = createRing(OUTPUT_SAMPLE_RATE, RING_SECONDS);
    const node = new AudioWorkletNode(context, 'pcm-player', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { ring },
    });
    const gain = context.createGain();
    node.connect(gain).connect(context.destination);
    this.gain = gain;
    this.applyGain();
    const views = ringViews(ring);
    const publishLatency = (): void => {
      const seconds = (context.outputLatency || 0) + context.baseLatency;
      Atomics.store(views.control, Control.LatencyUs, Math.round(seconds * 1e6));
    };
    publishLatency();
    setInterval(publishLatency, 500);
    return ring;
  }

  private applyGain(): void {
    if (this.gain) this.gain.gain.value = this.muted ? 0 : this.volume;
  }
}
```

`src/player/create-controller.ts`:
```ts
import type { Telemetry } from '../engine/protocol';
import { AudioOutput } from './audio-output';
import { PlayerController } from './player-controller';

export function createController(): PlayerController {
  const worker = new Worker(new URL('../engine/worker.ts', import.meta.url), { type: 'module' });
  const controller = new PlayerController(worker, new AudioOutput());
  if (new URLSearchParams(location.search).has('telemetry')) {
    const target = window as unknown as { __blurayTelemetry?: Telemetry | null };
    controller.subscribe(() => {
      target.__blurayTelemetry = controller.getSnapshot().telemetry;
    });
  }
  return controller;
}
```

- [ ] **Step 6: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both succeed. The build output contains a separate worker chunk and a worklet chunk under `dist/assets/`.

- [ ] **Step 7: Commit**

```bash
git add src/player
git commit -m "feat(player): add AudioWorklet output, worker bridge and React-facing controller store"
```

---

### Task 18: Landing-screen building blocks: capabilities, folder input, recent discs, formatting, keys

**Files:**
- Create: `src/ui/fs-access.d.ts`, `src/ui/capabilities.ts`, `src/ui/disc-input.ts`, `src/ui/recent-discs.ts`, `src/ui/format.ts`, `src/ui/keyboard.ts`
- Test: `src/ui/capabilities.test.ts`, `src/ui/disc-input.test.ts`, `src/ui/recent-discs.test.ts`, `src/ui/format.test.ts`, `src/ui/keyboard.test.ts`

**Interfaces:**
- Produces:
  - `checkCapabilities(g?): { ok; missing: string[]; canPickDirectory }`
  - `type DiscEntries = Array<[string, File]>`; `collectFromFileList(files)`; `collectFromDirectoryHandle(handle)`; `directoryFromDataTransfer(dt): Promise<FileSystemDirectoryHandle | null>` (it calls `getAsFileSystemHandle` synchronously, as the drop event requires)
  - `interface RecentDisc { name; handle; openedAt }`; `saveRecentDisc(handle, now?, factory?)`; `listRecentDiscs(factory?)`; `removeRecentDisc(name, factory?)`; `reopenRecentDisc(disc)`. The list keeps the 5 most recent, newest first.
  - `formatTime(us): string` (`m:ss` or `h:mm:ss`)
  - `type KeyAction = togglePlay | seekBy(deltaUs) | volumeBy(delta) | fullscreen`; `keyToAction(key): KeyAction | null`

- [ ] **Step 1: Add File System Access typings**

`src/ui/fs-access.d.ts`:
```ts
// Chromium File System Access additions not (yet) in lib.dom. If your TypeScript lib already declares one
// of these members, delete that line here.
interface Window {
  showDirectoryPicker?(options?: { id?: string; mode?: 'read' | 'readwrite' }): Promise<FileSystemDirectoryHandle>;
}

interface DataTransferItem {
  getAsFileSystemHandle?(): Promise<FileSystemHandle | null>;
}

interface FileSystemHandle {
  queryPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
}
```

- [ ] **Step 2: Write the failing tests**

`src/ui/capabilities.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { checkCapabilities } from './capabilities';

describe('checkCapabilities', () => {
  it('passes a fully capable Chromium-like environment', () => {
    const g = { VideoDecoder: class {}, AudioWorkletNode: class {}, OffscreenCanvas: class {}, SharedArrayBuffer, crossOriginIsolated: true, showDirectoryPicker: () => undefined };
    expect(checkCapabilities(g)).toEqual({ ok: true, missing: [], canPickDirectory: true });
  });

  it('names each missing capability', () => {
    const report = checkCapabilities({ OffscreenCanvas: class {}, crossOriginIsolated: false });
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual(['WebCodecs video decoding', 'AudioWorklet', 'cross-origin isolation (SharedArrayBuffer)']);
    expect(report.canPickDirectory).toBe(false);
  });
});
```

`src/ui/disc-input.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { collectFromDirectoryHandle, collectFromFileList, directoryFromDataTransfer } from './disc-input';

function file(name: string, relative = ''): File {
  const f = new File(['x'], name);
  Object.defineProperty(f, 'webkitRelativePath', { value: relative });
  return f;
}

function dir(name: string, children: Record<string, File | FileSystemDirectoryHandle>): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    name,
    async *entries() {
      for (const [childName, child] of Object.entries(children)) {
        if (child instanceof File) yield [childName, { kind: 'file', name: childName, getFile: async () => child }];
        else yield [childName, child];
      }
    },
  } as unknown as FileSystemDirectoryHandle;
}

describe('disc input', () => {
  it('uses webkitRelativePath from a folder <input>', () => {
    const a = file('index.bdmv', 'Movie/BDMV/index.bdmv');
    expect(collectFromFileList([a])).toEqual([['Movie/BDMV/index.bdmv', a]]);
  });

  it('walks a directory handle, prefixing the folder name', async () => {
    const idx = file('index.bdmv');
    const m2ts = file('00000.m2ts');
    const root = dir('Movie', { BDMV: dir('BDMV', { 'index.bdmv': idx, STREAM: dir('STREAM', { '00000.m2ts': m2ts }) }) });
    expect(await collectFromDirectoryHandle(root)).toEqual([
      ['Movie/BDMV/index.bdmv', idx],
      ['Movie/BDMV/STREAM/00000.m2ts', m2ts],
    ]);
  });

  it('finds a dropped directory handle', async () => {
    const handle = dir('Movie', {});
    const dt = { items: [{ kind: 'file', getAsFileSystemHandle: async () => handle }] } as unknown as DataTransfer;
    expect(await directoryFromDataTransfer(dt)).toBe(handle);
    const noHandles = { items: [{ kind: 'string' }] } as unknown as DataTransfer;
    expect(await directoryFromDataTransfer(noHandles)).toBeNull();
  });
});
```

`src/ui/recent-discs.test.ts`:
```ts
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { listRecentDiscs, removeRecentDisc, saveRecentDisc } from './recent-discs';

const handle = (name: string): FileSystemDirectoryHandle => ({ kind: 'directory', name }) as unknown as FileSystemDirectoryHandle;

describe('recent discs', () => {
  it('keeps the five most recent, newest first', async () => {
    const factory = new IDBFactory();
    for (let i = 0; i < 7; i++) await saveRecentDisc(handle(`Disc ${i}`), 1000 + i, factory);
    await saveRecentDisc(handle('Disc 2'), 2000, factory);
    expect((await listRecentDiscs(factory)).map((d) => d.name)).toEqual(['Disc 2', 'Disc 6', 'Disc 5', 'Disc 4', 'Disc 3']);
  });

  it('removes a disc', async () => {
    const factory = new IDBFactory();
    await saveRecentDisc(handle('A'), 1, factory);
    await removeRecentDisc('A', factory);
    expect(await listRecentDiscs(factory)).toEqual([]);
  });
});
```

`src/ui/format.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { formatTime } from './format';

describe('formatTime', () => {
  it('formats minutes and hours', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(8_000_000)).toBe('0:08');
    expect(formatTime(754_900_000)).toBe('12:34');
    expect(formatTime(7_384_000_000)).toBe('2:03:04');
    expect(formatTime(-5)).toBe('0:00');
  });
});
```

`src/ui/keyboard.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { keyToAction } from './keyboard';

describe('keyToAction', () => {
  it('maps the playback keys from the spec', () => {
    expect(keyToAction(' ')).toEqual({ type: 'togglePlay' });
    expect(keyToAction('ArrowLeft')).toEqual({ type: 'seekBy', deltaUs: -10_000_000 });
    expect(keyToAction('ArrowRight')).toEqual({ type: 'seekBy', deltaUs: 10_000_000 });
    expect(keyToAction('ArrowUp')).toEqual({ type: 'volumeBy', delta: 0.1 });
    expect(keyToAction('ArrowDown')).toEqual({ type: 'volumeBy', delta: -0.1 });
    expect(keyToAction('f')).toEqual({ type: 'fullscreen' });
    expect(keyToAction('F')).toEqual({ type: 'fullscreen' });
    expect(keyToAction('x')).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/ui`
Expected: FAIL, because the modules cannot be resolved.

- [ ] **Step 4: Implement the modules**

`src/ui/capabilities.ts`:
```ts
export interface CapabilityReport {
  readonly ok: boolean;
  readonly missing: readonly string[];
  readonly canPickDirectory: boolean;
}

export function checkCapabilities(g: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): CapabilityReport {
  const missing: string[] = [];
  if (!('VideoDecoder' in g)) missing.push('WebCodecs video decoding');
  if (!('AudioWorkletNode' in g)) missing.push('AudioWorklet');
  if (!('OffscreenCanvas' in g)) missing.push('OffscreenCanvas');
  if (!('SharedArrayBuffer' in g) || g.crossOriginIsolated !== true) missing.push('cross-origin isolation (SharedArrayBuffer)');
  return { ok: missing.length === 0, missing, canPickDirectory: typeof g.showDirectoryPicker === 'function' };
}
```

`src/ui/disc-input.ts`:
```ts
export type DiscEntries = Array<[string, File]>;

const MAX_DEPTH = 6;

export function collectFromFileList(files: Iterable<File>): DiscEntries {
  return [...files].map((f) => [f.webkitRelativePath || f.name, f]);
}

export async function collectFromDirectoryHandle(handle: FileSystemDirectoryHandle, prefix = handle.name, depth = 0): Promise<DiscEntries> {
  if (depth > MAX_DEPTH) return [];
  const out: DiscEntries = [];
  for await (const [name, entry] of handle.entries()) {
    const path = `${prefix}/${name}`;
    if (entry.kind === 'file') out.push([path, await (entry as FileSystemFileHandle).getFile()]);
    else out.push(...(await collectFromDirectoryHandle(entry as FileSystemDirectoryHandle, path, depth + 1)));
  }
  return out;
}

/** Must be called synchronously from the drop handler: items become unusable after the event returns. */
export async function directoryFromDataTransfer(dt: DataTransfer): Promise<FileSystemDirectoryHandle | null> {
  const pending = Array.from(dt.items)
    .filter((item) => item.kind === 'file' && typeof item.getAsFileSystemHandle === 'function')
    .map((item) => item.getAsFileSystemHandle?.());
  for (const promise of pending) {
    const handle = await promise;
    if (handle && handle.kind === 'directory') return handle as FileSystemDirectoryHandle;
  }
  return null;
}
```

`src/ui/recent-discs.ts`:
```ts
const DB_NAME = 'bluray-web';
const STORE = 'recent-discs';
const MAX_RECENT = 5;

export interface RecentDisc {
  readonly name: string;
  readonly handle: FileSystemDirectoryHandle;
  readonly openedAt: number;
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'name' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(factory: IDBFactory, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb(factory);
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = run(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function listRecentDiscs(factory: IDBFactory = indexedDB): Promise<RecentDisc[]> {
  const all = (await withStore<RecentDisc[]>(factory, 'readonly', (store) => store.getAll() as IDBRequest<RecentDisc[]>)) ?? [];
  return all.sort((a, b) => b.openedAt - a.openedAt);
}

export async function saveRecentDisc(handle: FileSystemDirectoryHandle, now = Date.now(), factory: IDBFactory = indexedDB): Promise<void> {
  await withStore(factory, 'readwrite', (store) => {
    store.put({ name: handle.name, handle, openedAt: now });
  });
  const stale = (await listRecentDiscs(factory)).slice(MAX_RECENT);
  for (const disc of stale) await removeRecentDisc(disc.name, factory);
}

export async function removeRecentDisc(name: string, factory: IDBFactory = indexedDB): Promise<void> {
  await withStore(factory, 'readwrite', (store) => {
    store.delete(name);
  });
}

/** Returns the handle if read permission is (or becomes) granted. Call from a click handler. */
export async function reopenRecentDisc(disc: RecentDisc): Promise<FileSystemDirectoryHandle | null> {
  const descriptor = { mode: 'read' as const };
  if ((await disc.handle.queryPermission?.(descriptor)) === 'granted') return disc.handle;
  return (await disc.handle.requestPermission?.(descriptor)) === 'granted' ? disc.handle : null;
}
```

`src/ui/format.ts`:
```ts
export function formatTime(us: number): string {
  const total = Math.max(0, Math.floor(us / 1e6));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
```

`src/ui/keyboard.ts`:
```ts
export type KeyAction =
  | { readonly type: 'togglePlay' }
  | { readonly type: 'seekBy'; readonly deltaUs: number }
  | { readonly type: 'volumeBy'; readonly delta: number }
  | { readonly type: 'fullscreen' };

/** Playback keys (spec §7). Menu keys (arrows/Enter/digits to IG, M, P) arrive in M3; subtitle keys in M4. */
export function keyToAction(key: string): KeyAction | null {
  switch (key) {
    case ' ':
      return { type: 'togglePlay' };
    case 'ArrowLeft':
      return { type: 'seekBy', deltaUs: -10_000_000 };
    case 'ArrowRight':
      return { type: 'seekBy', deltaUs: 10_000_000 };
    case 'ArrowUp':
      return { type: 'volumeBy', delta: 0.1 };
    case 'ArrowDown':
      return { type: 'volumeBy', delta: -0.1 };
    case 'f':
    case 'F':
      return { type: 'fullscreen' };
    default:
      return null;
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/ui && npm run typecheck`
Expected: all pass. If typecheck reports a duplicate member in `fs-access.d.ts`, delete that member there; your lib.dom already declares it.

- [ ] **Step 6: Commit**

```bash
git add src/ui
git commit -m "feat(ui): add capability check, folder collection, recent discs, time format and key map"
```

---

### Task 19: React screens: landing, player, control bar, playlist picker

**Files:**
- Create: `src/ui/LandingScreen.tsx`, `src/ui/PlayerScreen.tsx`, `src/ui/ControlBar.tsx`, `src/ui/PlaylistPicker.tsx`
- Modify: `src/ui/App.tsx` (replace the placeholder), `src/ui/styles.css` (append)
- Test: verified by `tests/e2e/*` in Task 20. These components are thin views over `PlayerController`, whose logic is unit-tested in Task 17, and over the helpers from Task 18.

**Interfaces:**
- Consumes: `PlayerController`, `PlayerSnapshot`, `createController` (Task 17); everything in Task 18; `formatTime`; `Chapter`; `PlaylistSummary`.
- Produces test ids used by E2E:
  - root `app`; landing `landing`, `open-folder`, `folder-input`, `error`
  - picker `playlist-picker`, `playlist-<id>`
  - player `player` (with `data-state` = engine state), `video-canvas`, `play-toggle`, `next-chapter`, `seek`, `time`

- [ ] **Step 1: Replace `src/ui/App.tsx`**

```tsx
import { useState, useSyncExternalStore, type ReactElement } from 'react';
import { createController } from '../player/create-controller';
import type { PlayerController } from '../player/player-controller';
import { LandingScreen } from './LandingScreen';
import { PlayerScreen } from './PlayerScreen';

let sharedController: PlayerController | null = null;

function getController(): PlayerController {
  sharedController ??= createController();
  return sharedController;
}

export function App(): ReactElement {
  const [controller] = useState(getController);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return (
    <div className="app" data-testid="app">
      {snapshot.playlists.length === 0 ? (
        <LandingScreen controller={controller} snapshot={snapshot} />
      ) : (
        <PlayerScreen controller={controller} snapshot={snapshot} />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create `src/ui/LandingScreen.tsx`**

```tsx
import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type ReactElement } from 'react';
import type { PlayerController, PlayerSnapshot } from '../player/player-controller';
import { checkCapabilities } from './capabilities';
import { collectFromDirectoryHandle, collectFromFileList, directoryFromDataTransfer } from './disc-input';
import { listRecentDiscs, reopenRecentDisc, saveRecentDisc, type RecentDisc } from './recent-discs';

interface LandingScreenProps {
  readonly controller: PlayerController;
  readonly snapshot: PlayerSnapshot;
}

export function LandingScreen({ controller, snapshot }: LandingScreenProps): ReactElement {
  const [capabilities] = useState(() => checkCapabilities());
  const [recent, setRecent] = useState<RecentDisc[]>([]);
  const [dragging, setDragging] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.setAttribute('webkitdirectory', '');
    listRecentDiscs().then(setRecent, () => setRecent([]));
  }, []);

  const run = (task: Promise<void>): void => {
    task.catch((err: unknown) => setLocalError(err instanceof Error ? err.message : String(err)));
  };

  const openHandle = async (handle: FileSystemDirectoryHandle): Promise<void> => {
    controller.open(await collectFromDirectoryHandle(handle));
    try {
      await saveRecentDisc(handle);
      setRecent(await listRecentDiscs());
    } catch {
      // The recent-discs list is a convenience; failing to update it must not block playback.
    }
  };

  const pickFolder = async (): Promise<void> => {
    let handle: FileSystemDirectoryHandle | undefined;
    try {
      handle = await window.showDirectoryPicker?.({ id: 'bluray-disc', mode: 'read' });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      throw err;
    }
    if (handle) await openHandle(handle);
  };

  const onPickFolder = (): void => {
    setLocalError(null);
    controller.startAudio(); // must happen inside the click gesture
    if (!capabilities.canPickDirectory) {
      inputRef.current?.click();
      return;
    }
    run(pickFolder());
  };

  const onInput = (e: ChangeEvent<HTMLInputElement>): void => {
    setLocalError(null);
    const files = e.target.files;
    if (files && files.length > 0) controller.open(collectFromFileList(files));
    e.target.value = '';
  };

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragging(false);
    setLocalError(null);
    controller.startAudio();
    const pending = directoryFromDataTransfer(e.dataTransfer); // synchronous part must run inside the event
    run(
      pending.then(async (handle) => {
        if (!handle) {
          setLocalError('Drop the disc folder itself (the folder that contains BDMV).');
          return;
        }
        await openHandle(handle);
      }),
    );
  };

  const onRecent = (disc: RecentDisc): void => {
    setLocalError(null);
    controller.startAudio();
    run(
      reopenRecentDisc(disc).then(async (handle) => {
        if (!handle) {
          setLocalError(`Permission to read "${disc.name}" was not granted.`);
          return;
        }
        await openHandle(handle);
      }),
    );
  };

  const error = localError ?? snapshot.error?.message ?? null;
  const errorPaths = localError ? [] : (snapshot.error?.paths ?? []);

  return (
    <main className="landing" data-testid="landing">
      <h1>Blu-ray Player</h1>
      {!capabilities.ok && (
        <div className="error-banner" role="alert">
          This browser is missing: {capabilities.missing.join(', ')}. Use a recent desktop Chrome or Edge.
        </div>
      )}
      <div
        className={`drop-zone${dragging ? ' dragging' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <p>Drop a decrypted Blu-ray folder here: the disc folder, or the BDMV folder inside it.</p>
        <button type="button" data-testid="open-folder" disabled={!capabilities.ok} onClick={onPickFolder}>
          Open disc folder
        </button>
        <input ref={inputRef} type="file" multiple hidden data-testid="folder-input" onChange={onInput} />
      </div>
      {snapshot.engineState === 'loading' && <p className="status">Reading disc…</p>}
      {error && (
        <div className="error-banner" role="alert" data-testid="error">
          {error}
          {errorPaths.length > 0 && (
            <ul>
              {errorPaths.map((p) => (
                <li key={p}>
                  <code>{p}</code>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {recent.length > 0 && (
        <section className="recent">
          <h2>Recent discs</h2>
          <ul>
            {recent.map((disc) => (
              <li key={disc.name}>
                <button type="button" onClick={() => onRecent(disc)}>
                  {disc.name}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
```

- [ ] **Step 3: Create `src/ui/PlaylistPicker.tsx`**

```tsx
import type { ReactElement } from 'react';
import type { PlaylistSummary } from '../engine/disc/open-disc';
import { formatTime } from './format';

interface PlaylistPickerProps {
  readonly playlists: readonly PlaylistSummary[];
  readonly usesBdj: boolean;
  onPick(playlistId: string): void;
  readonly onClose?: () => void;
  onCloseDisc(): void;
}

export function PlaylistPicker({ playlists, usesBdj, onPick, onClose, onCloseDisc }: PlaylistPickerProps): ReactElement {
  const mainId = playlists.find((p) => p.playable)?.id;
  return (
    <div className="picker-backdrop">
      <div className="picker" role="dialog" aria-label="Choose a playlist" data-testid="playlist-picker">
        <h2>Choose what to play</h2>
        {usesBdj && <p className="hint">This disc uses BD-J menus, which aren't supported. The longest playlist is usually the main feature.</p>}
        <ul>
          {playlists.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="playlist"
                disabled={!p.playable}
                title={p.playable ? undefined : `Missing: ${p.missingPaths.join(', ')}`}
                data-testid={`playlist-${p.id}`}
                onClick={() => onPick(p.id)}
              >
                <span className="playlist-id">{p.id}</span>
                <span>{formatTime(p.durationUs)}</span>
                <span>{p.chapterCount} chapters</span>
                {p.id === mainId && <span className="badge">Main feature</span>}
              </button>
            </li>
          ))}
        </ul>
        <div className="picker-actions">
          <button type="button" onClick={onCloseDisc}>
            Open another disc
          </button>
          {onClose && (
            <button type="button" onClick={onClose}>
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create `src/ui/ControlBar.tsx`**

```tsx
import { useState, type ReactElement } from 'react';
import type { Chapter } from '../engine/nav/timeline';
import type { PlayerController, PlayerSnapshot } from '../player/player-controller';
import { formatTime } from './format';

interface SeekBarProps {
  readonly durationUs: number;
  readonly timeUs: number;
  readonly chapters: readonly Chapter[];
  onSeek(timeUs: number): void;
}

function SeekBar({ durationUs, timeUs, chapters, onSeek }: SeekBarProps): ReactElement {
  const [dragUs, setDragUs] = useState<number | null>(null);
  const max = Math.max(1, durationUs);
  const commit = (): void => {
    if (dragUs !== null) onSeek(dragUs);
    setDragUs(null);
  };
  return (
    <div className="seek-bar">
      <input
        type="range"
        aria-label="Seek"
        data-testid="seek"
        min={0}
        max={max}
        step={100_000}
        value={Math.min(dragUs ?? timeUs, max)}
        onChange={(e) => setDragUs(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
      />
      {durationUs > 0 &&
        chapters.map((c) => <span key={c.index} className="chapter-tick" style={{ left: `${(c.startUs / durationUs) * 100}%` }} />)}
    </div>
  );
}

interface ControlBarProps {
  readonly controller: PlayerController;
  readonly snapshot: PlayerSnapshot;
  readonly visible: boolean;
  onOpenPlaylists(): void;
  onFullscreen(): void;
}

export function ControlBar({ controller, snapshot, visible, onOpenPlaylists, onFullscreen }: ControlBarProps): ReactElement {
  const playing = snapshot.engineState === 'playing' || snapshot.engineState === 'buffering';
  const silent = snapshot.muted || snapshot.volume === 0;
  return (
    <div className={`control-bar${visible ? '' : ' hidden'}`} data-testid="control-bar">
      <SeekBar durationUs={snapshot.durationUs} timeUs={snapshot.timeUs} chapters={snapshot.chapters} onSeek={(us) => controller.seek(us)} />
      <div className="control-row">
        <button type="button" aria-label="Previous chapter" onClick={() => controller.prevChapter()}>
          ⏮
        </button>
        <button type="button" aria-label={playing ? 'Pause' : 'Play'} data-testid="play-toggle" onClick={() => controller.togglePlay()}>
          {playing ? '⏸' : '▶'}
        </button>
        <button type="button" aria-label="Next chapter" data-testid="next-chapter" onClick={() => controller.nextChapter()}>
          ⏭
        </button>
        <span className="time" data-testid="time">
          {formatTime(snapshot.timeUs)} / {formatTime(snapshot.durationUs)}
        </span>
        <span className="spacer" />
        <button type="button" aria-label={snapshot.muted ? 'Unmute' : 'Mute'} onClick={() => controller.toggleMute()}>
          {silent ? '🔇' : '🔊'}
        </button>
        <input
          type="range"
          aria-label="Volume"
          min={0}
          max={1}
          step={0.05}
          value={snapshot.muted ? 0 : snapshot.volume}
          onChange={(e) => {
            if (snapshot.muted) controller.toggleMute();
            controller.setVolume(Number(e.target.value));
          }}
        />
        <button type="button" onClick={onOpenPlaylists}>
          Playlists
        </button>
        <button type="button" aria-label="Fullscreen" onClick={onFullscreen}>
          ⛶
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Create `src/ui/PlayerScreen.tsx`**

```tsx
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { PlayerController, PlayerSnapshot } from '../player/player-controller';
import { ControlBar } from './ControlBar';
import { keyToAction } from './keyboard';
import { PlaylistPicker } from './PlaylistPicker';

const HIDE_CONTROLS_MS = 3000;

interface PlayerScreenProps {
  readonly controller: PlayerController;
  readonly snapshot: PlayerSnapshot;
}

function toggleFullscreen(element: HTMLElement | null): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void element?.requestFullscreen();
}

export function PlayerScreen({ controller, snapshot }: PlayerScreenProps): ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [idle, setIdle] = useState(false);
  const [activity, setActivity] = useState(0);
  const playing = snapshot.engineState === 'playing';

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    controller.attachCanvas(canvas);
    const observer = new ResizeObserver(([entry]) => {
      const dpr = window.devicePixelRatio || 1;
      controller.resize(entry.contentRect.width * dpr, entry.contentRect.height * dpr);
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [controller]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLButtonElement || target instanceof HTMLTextAreaElement) return;
      const action = keyToAction(e.key);
      if (!action) return;
      e.preventDefault();
      switch (action.type) {
        case 'togglePlay':
          controller.togglePlay();
          break;
        case 'seekBy':
          controller.seekBy(action.deltaUs);
          break;
        case 'volumeBy':
          controller.setVolume(controller.getSnapshot().volume + action.delta);
          break;
        case 'fullscreen':
          toggleFullscreen(rootRef.current);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [controller]);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => setIdle(true), HIDE_CONTROLS_MS);
    return () => window.clearTimeout(timer);
  }, [playing, activity]);

  const wake = (): void => {
    setIdle(false);
    setActivity((a) => a + 1);
  };

  const controlsVisible = !idle || !playing;
  const showPicker = pickerOpen || snapshot.currentPlaylistId === null;

  return (
    <div
      ref={rootRef}
      className={`player${controlsVisible ? '' : ' idle'}`}
      data-testid="player"
      data-state={snapshot.engineState}
      onMouseMove={wake}
    >
      <canvas ref={canvasRef} className="player-canvas" data-testid="video-canvas" onClick={() => controller.togglePlay()} />
      <div className="notices">
        {snapshot.error && (
          <div className="error-banner" role="alert" data-testid="error">
            {snapshot.error.message}
          </div>
        )}
        {snapshot.notices.map((n) => (
          <div key={n.code} className="notice" role="status">
            {n.message}
            <button type="button" aria-label="Dismiss" onClick={() => controller.dismissNotice(n.code)}>
              ×
            </button>
          </div>
        ))}
      </div>
      {snapshot.engineState === 'buffering' && <div className="spinner" aria-label="Buffering" />}
      {showPicker && (
        <PlaylistPicker
          playlists={snapshot.playlists}
          usesBdj={snapshot.usesBdj}
          onPick={(id) => {
            setPickerOpen(false);
            controller.playPlaylist(id);
          }}
          onClose={snapshot.currentPlaylistId === null ? undefined : () => setPickerOpen(false)}
          onCloseDisc={() => controller.closeDisc()}
        />
      )}
      <ControlBar
        controller={controller}
        snapshot={snapshot}
        visible={controlsVisible}
        onOpenPlaylists={() => setPickerOpen(true)}
        onFullscreen={() => toggleFullscreen(rootRef.current)}
      />
    </div>
  );
}
```

- [ ] **Step 6: Append styles to `src/ui/styles.css`**

```css
button { font: inherit; color: inherit; background: #26262c; border: 1px solid #3a3a42; border-radius: 6px; padding: 6px 12px; cursor: pointer; }
button:disabled { opacity: 0.45; cursor: not-allowed; }
.app { height: 100%; }

.landing { max-width: 720px; margin: 0 auto; padding: 48px 24px; display: flex; flex-direction: column; gap: 20px; }
.drop-zone { border: 2px dashed #4a4a55; border-radius: 12px; padding: 40px; text-align: center; }
.drop-zone.dragging { border-color: #6ea8ff; background: #14182a; }
.error-banner { background: #3a1518; border: 1px solid #7a2a30; border-radius: 8px; padding: 12px 16px; }
.recent ul { list-style: none; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }

.player { position: relative; height: 100%; background: #000; overflow: hidden; }
.player.idle { cursor: none; }
.player-canvas { width: 100%; height: 100%; display: block; }
.notices { position: absolute; top: 12px; left: 12px; right: 12px; display: flex; flex-direction: column; gap: 8px; pointer-events: none; }
.notices > * { pointer-events: auto; }
.notice { background: rgba(30, 30, 36, 0.92); border-radius: 8px; padding: 8px 12px; display: flex; gap: 12px; align-items: center; justify-content: space-between; }
.spinner { position: absolute; top: 50%; left: 50%; width: 48px; height: 48px; margin: -24px; border: 4px solid #ffffff33; border-top-color: #fff; border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.control-bar { position: absolute; left: 0; right: 0; bottom: 0; padding: 12px 16px; background: linear-gradient(transparent, rgba(0, 0, 0, 0.85)); transition: opacity 0.2s; }
.control-bar.hidden { opacity: 0; pointer-events: none; }
.control-row { display: flex; align-items: center; gap: 8px; }
.control-row .spacer { flex: 1; }
.time { font-variant-numeric: tabular-nums; }
.seek-bar { position: relative; margin-bottom: 8px; }
.seek-bar input { width: 100%; }
.chapter-tick { position: absolute; top: 50%; width: 2px; height: 10px; margin-top: -5px; background: #ffffffaa; pointer-events: none; }

.picker-backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.7); display: flex; align-items: center; justify-content: center; }
.picker { background: #18181d; border-radius: 12px; padding: 24px; min-width: 420px; max-height: 80%; overflow: auto; }
.picker ul { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.playlist { width: 100%; display: grid; grid-template-columns: 80px 80px 1fr auto; gap: 12px; text-align: left; }
.badge { background: #2d5bd6; border-radius: 999px; padding: 0 8px; font-size: 0.85em; }
.picker-actions { display: flex; justify-content: space-between; margin-top: 16px; }
```

- [ ] **Step 7: Build and check manually**

Run: `npm run typecheck && npm test && npm run build`
Expected: all pass.

Then run `npm run dev`, open the printed URL in Chrome, and click **Open disc folder**. If you have no disc yet, pick `fixtures/synthetic/disc1` after Task 20 generates it; until then, any folder without `BDMV` should show the "No BDMV folder" error.

- [ ] **Step 8: Commit**

```bash
git add src/ui
git commit -m "feat(ui): add landing, playlist picker, player screen and control bar"
```

---

### Task 20: Synthetic fixture disc and Playwright end-to-end tests

**Files:**
- Create: `scripts/make-fixture-disc.ts`, `fixtures/synthetic/not-a-disc/readme.txt`, `tests/e2e/playback.spec.ts`, `tests/e2e/errors.spec.ts`
- Generate and commit: `fixtures/synthetic/disc1/BDMV/**`

**Interfaces:**
- Consumes: `buildSyntheticDisc`, `CLIP_START_PTS`, `SyntheticClipSpec` (Task 15); `CodingType`; all UI test ids (Task 19); `window.__blurayTelemetry` (Task 17).
- Produces:
  - `fixtures/synthetic/disc1`, which holds:
    - playlist `00000`: two play items of 4 s each (real H.264 640×360 at 24 fps plus 48 kHz LPCM), chapters every 2 s
    - playlist `00001`: the second clip alone
  - CLI: `tsx scripts/make-fixture-disc.ts <outDir> [--seconds-per-clip N]`

Requires `ffmpeg` with `libx264` on PATH (only to regenerate fixtures; CI uses the committed files).

- [ ] **Step 1: Write the fixture generator**

`scripts/make-fixture-disc.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CodingType } from '../src/engine/bdmv/stream-types';
import { CLIP_START_PTS, buildSyntheticDisc, type SyntheticClipSpec } from '../tests/helpers/synthetic-disc';

const [outDir, ...args] = process.argv.slice(2);
if (!outDir) {
  console.error('usage: tsx scripts/make-fixture-disc.ts <outDir> [--seconds-per-clip N]');
  process.exit(1);
}
const flag = args.indexOf('--seconds-per-clip');
const secondsPerClip = flag >= 0 ? Number(args[flag + 1]) : 4;
const framesPerClip = secondsPerClip * 24;

// IDR every second, no B-frames (so PTS = DTS = frame index), AUD before every access unit,
// SPS/PPS repeated at every IDR so any keyframe can start decoding.
const h264 = execFileSync(
  'ffmpeg',
  [
    '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24',
    '-frames:v', String(framesPerClip * 2),
    '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p',
    '-x264-params', 'keyint=24:min-keyint=24:scenecut=0:bframes=0:aud=1:repeat-headers=1',
    '-f', 'h264', '-',
  ],
  { maxBuffer: 1 << 30 },
);

/** Splits an Annex-B stream at access unit delimiters (NAL type 9). */
function splitAccessUnits(stream: Uint8Array): Uint8Array[] {
  const starts: number[] = [];
  for (let i = 0; i + 3 < stream.length; i++) {
    if (stream[i] === 0 && stream[i + 1] === 0 && stream[i + 2] === 1 && (stream[i + 3] & 0x1f) === 9) {
      starts.push(i > 0 && stream[i - 1] === 0 ? i - 1 : i);
    }
  }
  return starts.map((s, k) => stream.subarray(s, k + 1 < starts.length ? starts[k + 1] : stream.length));
}

const aus = splitAccessUnits(new Uint8Array(h264));
if (aus.length !== framesPerClip * 2) throw new Error(`expected ${framesPerClip * 2} access units, got ${aus.length}`);

const keyIndices = Array.from({ length: framesPerClip / 24 }, (_, i) => i * 24);
const clip = (clipId: string, from: number): SyntheticClipSpec => ({
  clipId,
  videoAus: aus.slice(from, from + framesPerClip),
  keyIndices,
  startPts: CLIP_START_PTS,
  audio: CodingType.LPCM,
});

const files = buildSyntheticDisc({
  clips: [clip('00001', 0), clip('00002', framesPerClip)],
  playlists: [
    { id: '00000', clipIds: ['00001', '00002'], chapterEverySeconds: 2 },
    { id: '00001', clipIds: ['00002'] },
  ],
});

rmSync(outDir, { recursive: true, force: true });
for (const [path, bytes] of files) {
  const target = join(outDir, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}
console.log(`wrote ${files.size} files to ${outDir}`);
```

- [ ] **Step 2: Generate and inspect the fixture**

Run:
```bash
npm run fixture:synthetic
mkdir -p fixtures/synthetic/not-a-disc && echo "This folder intentionally has no BDMV directory." > fixtures/synthetic/not-a-disc/readme.txt
find fixtures/synthetic -type f | sort && du -sh fixtures/synthetic/disc1
ffprobe -v error -show_entries stream=codec_name,codec_type -of csv fixtures/synthetic/disc1/BDMV/STREAM/00001.m2ts
```
Expected:
- `find` lists `BDMV/index.bdmv`, `PLAYLIST/00000.mpls`, `PLAYLIST/00001.mpls`, two `.clpi` files and two `.m2ts` files, plus `not-a-disc/readme.txt`.
- `du` reports a few MB.
- `ffprobe` reports `h264,video` and `pcm_bluray,audio`. That is an independent check that the muxer writes valid Blu-ray M2TS.

- [ ] **Step 3: Write the E2E tests**

`tests/e2e/playback.spec.ts`:
```ts
import { expect, test, type Page } from '@playwright/test';

const DISC = 'fixtures/synthetic/disc1';
const SYNC_TOLERANCE_US = 20_000;

interface TelemetrySample {
  clockUs: number;
  clockMode: string;
  avOffsetMeanUs: number | null;
  avOffsetMaxAbsUs: number | null;
  framesInWindow: number;
}

async function telemetry(page: Page): Promise<TelemetrySample | null> {
  return page.evaluate(() => (window as unknown as { __blurayTelemetry?: TelemetrySample | null }).__blurayTelemetry ?? null);
}

async function openDisc(page: Page, folder = DISC): Promise<void> {
  await page.goto('/?telemetry=1');
  await page.getByTestId('folder-input').setInputFiles(folder);
  await expect(page.getByTestId('playlist-00000')).toBeVisible();
}

async function startPlaylist(page: Page, id: string): Promise<void> {
  await page.getByTestId(`playlist-${id}`).click();
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });
}

/** Telemetry windows that presented frames, polled until the clock passes `untilUs`. */
async function collectWindows(page: Page, untilUs: number): Promise<TelemetrySample[]> {
  const windows: TelemetrySample[] = [];
  let lastClock = -1;
  for (;;) {
    const t = await telemetry(page);
    if (t && t.clockUs !== lastClock) {
      lastClock = t.clockUs;
      if (t.framesInWindow > 0) windows.push(t);
      if (t.clockUs >= untilUs) return windows;
    }
    await page.waitForTimeout(250);
  }
}

test('lists playlists with the main feature first', async ({ page }) => {
  await openDisc(page);
  await expect(page.getByTestId('playlist-00000')).toContainText('Main feature');
  await expect(page.getByTestId('playlist-00000')).toContainText('0:08');
  await expect(page.getByTestId('playlist-00001')).toContainText('0:04');
});

test('plays in sync across the play-item boundary to the end', async ({ page }) => {
  await openDisc(page);
  await startPlaylist(page, '00000');
  const windows = await collectWindows(page, 7_000_000);
  expect(windows.length).toBeGreaterThan(5);
  for (const w of windows) {
    // 'wall' here means the browser has no running audio output (see Step 5).
    expect(w.clockMode).toBe('audio');
    expect(Math.abs(w.avOffsetMeanUs ?? 0)).toBeLessThanOrEqual(SYNC_TOLERANCE_US);
  }
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'ended', { timeout: 10_000 });
});

test('skips to the next chapter and is back in sync within a second', async ({ page }) => {
  await openDisc(page);
  await startPlaylist(page, '00000');
  await page.getByTestId('player').hover();
  await page.getByTestId('next-chapter').click();
  await expect.poll(async () => (await telemetry(page))?.clockUs ?? 0).toBeGreaterThanOrEqual(2_000_000);
  await page.waitForTimeout(1000);
  const windows = await collectWindows(page, 3_500_000);
  expect(windows.length).toBeGreaterThan(0);
  for (const w of windows) expect(Math.abs(w.avOffsetMeanUs ?? 0)).toBeLessThanOrEqual(SYNC_TOLERANCE_US);
});

test('pauses and resumes', async ({ page }) => {
  await openDisc(page);
  await startPlaylist(page, '00000');
  await page.keyboard.press('Space');
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'paused');
  const paused = (await telemetry(page))?.clockUs ?? 0;
  await page.waitForTimeout(1000);
  expect(Math.abs(((await telemetry(page))?.clockUs ?? 0) - paused)).toBeLessThan(50_000);
  await page.keyboard.press('Space');
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing');
});

test('stays in sync for ten minutes (nightly)', async ({ page }) => {
  test.skip(!process.env.NIGHTLY, 'Set NIGHTLY=1 after generating fixtures/local/long-disc (see Task 20 Step 5).');
  test.setTimeout(13 * 60_000);
  await page.goto('/?telemetry=1');
  await page.getByTestId('folder-input').setInputFiles('fixtures/local/long-disc');
  await startPlaylist(page, '00000');
  const windows = await collectWindows(page, 590_000_000);
  for (const w of windows) expect(Math.abs(w.avOffsetMeanUs ?? 0)).toBeLessThanOrEqual(SYNC_TOLERANCE_US);
  const mean = (ws: TelemetrySample[]): number => ws.reduce((a, w) => a + (w.avOffsetMeanUs ?? 0), 0) / ws.length;
  expect(Math.abs(mean(windows.slice(-20)) - mean(windows.slice(0, 20)))).toBeLessThan(5_000); // no drift
});
```

`tests/e2e/errors.spec.ts`:
```ts
import { expect, test } from '@playwright/test';

test('explains when the folder is not a Blu-ray disc', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('folder-input').setInputFiles('fixtures/synthetic/not-a-disc');
  await expect(page.getByTestId('error')).toContainText('No BDMV folder');
});
```

- [ ] **Step 4: Run the E2E suite**

Run: `npm run test:e2e`
Expected: 6 passed, 1 skipped (the nightly test).

If a test fails:
- **`clockMode` is `wall`:** the browser has no running audio output, so the heartbeat fallback kicked in. Re-run headed (`npx playwright test --headed`) to confirm. On Linux CI, install PulseAudio (or another sound server) or use a machine with an audio device. Do not weaken the assertion.
- **Video never reaches `playing`:** check the browser console (`npx playwright test --debug`) for `VideoDecoder` errors. Confirm the `chrome` channel is installed, because Playwright's bundled Chromium lacks H.264.

- [ ] **Step 5: Document long-fixture generation for the nightly test**

Append to `README.md`:
```markdown
## Nightly sync test

    npx tsx scripts/make-fixture-disc.ts fixtures/local/long-disc --seconds-per-clip 300
    NIGHTLY=1 npx playwright test -g "ten minutes"
```

- [ ] **Step 6: Commit**

```bash
git add scripts fixtures/synthetic tests/e2e README.md
git commit -m "test: add synthetic fixture disc and end-to-end playback, sync and error tests"
```

---

### Task 21: Real-disc checks against local backups

**Files:**
- Create: `tests/local/real-discs.test.ts`

**Interfaces:**
- Consumes: `normalizeDiscPaths`, `FileSource`, `openDisc`, `loadClips`, `streamPath` (Task 6); `Timeline` (Task 7); `M2tsReader` (Task 8); `chooseStreams` (Task 15); `hasSps` (Task 10); `analyzeAvc`/`analyzeHevc` and the codec-string helpers (Task 9); `CodingType`.
- Produces: a suite that runs only when `fixtures/local/<name>/BDMV` exists. It uses Node's `fs.openAsBlob`, which reads lazily, so multi-GB clips are never loaded into memory.

- [ ] **Step 1: Write the test**

`tests/local/real-discs.test.ts`:
```ts
import { existsSync, openAsBlob, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodingType } from '../../src/engine/bdmv/stream-types';
import { analyzeAvc, avcCodecString } from '../../src/engine/decode/h264';
import { analyzeHevc, hevcCodecString } from '../../src/engine/decode/hevc';
import { hasSps } from '../../src/engine/decode/video-decoder';
import { FileSource } from '../../src/engine/disc/file-source';
import { loadClips, openDisc, streamPath } from '../../src/engine/disc/open-disc';
import { normalizeDiscPaths } from '../../src/engine/disc/paths';
import { M2tsReader } from '../../src/engine/demux/m2ts-reader';
import { Timeline } from '../../src/engine/nav/timeline';
import { chooseStreams } from '../../src/engine/playback/stream-selection';

const LOCAL = 'fixtures/local';

function localDiscs(): string[] {
  if (!existsSync(LOCAL)) return [];
  return readdirSync(LOCAL)
    .map((name) => join(LOCAL, name))
    .filter((dir) => existsSync(join(dir, 'BDMV')));
}

async function entriesOf(dir: string): Promise<Array<[string, Blob]>> {
  const out: Array<[string, Blob]> = [];
  const walk = async (path: string): Promise<void> => {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) await walk(full);
      else out.push([relative(dir, full).split(sep).join('/'), await openAsBlob(full)]);
    }
  };
  await walk(dir);
  return out;
}

const discs = localDiscs();

describe.skipIf(discs.length === 0)('local discs', () => {
  for (const dir of discs) {
    it(`parses and demuxes ${dir}`, async () => {
      const source = new FileSource(normalizeDiscPaths(await entriesOf(dir)));
      const disc = await openDisc(source);
      const main = disc.summaries.find((s) => s.playable);
      expect(main, 'a playable playlist').toBeDefined();
      if (!main) return;
      const mpls = disc.playlists.get(main.id);
      if (!mpls) throw new Error(`playlist ${main.id} vanished`);

      const timeline = new Timeline(mpls.playItems);
      expect(Math.abs(timeline.durationUs - main.durationUs)).toBeLessThan(1000);
      const clips = await loadClips(source, main.clipIds);
      for (const clip of clips.values()) {
        for (const map of clip.epMaps) {
          map.entries.forEach((e, i) => {
            if (i > 0) expect(e.spn).toBeGreaterThanOrEqual(map.entries[i - 1].spn);
          });
        }
      }

      const choice = chooseStreams(mpls.playItems[0].stn);
      const video = choice.video;
      expect(video, 'a main-path video stream').not.toBeNull();
      if (!video) return;
      const reader = new M2tsReader({ source, path: streamPath(mpls.playItems[0].clipId), startSpn: 0, pids: new Set([video.pid]) });
      const first = (await reader.next())?.find((p) => hasSps(video.codingType, p.payload));
      if (video.codingType === CodingType.AVC || video.codingType === CodingType.HEVC) {
        expect(first, 'an access unit with SPS in the first 2 MB').toBeDefined();
        if (!first) return;
        const sps = (video.codingType === CodingType.AVC ? analyzeAvc : analyzeHevc)(first.payload).sps;
        if (!sps) throw new Error('SPS disappeared');
        const codec = video.codingType === CodingType.AVC ? avcCodecString(sps) : hevcCodecString(sps);
        expect(codec).toMatch(/^(avc1|hev1)\./);
        console.info(`${dir}: main=${main.id} ${(main.durationUs / 60e6).toFixed(1)} min, ${codec}, audio=${choice.audio ? 'LPCM' : choice.unsupportedAudio.map((a) => a.codingType.toString(16)).join('/')}, bdj=${disc.usesBdj}`);
      }
      expect(reader.stats.corruptPackets).toBe(0);
    }, 60_000);
  }
});
```

- [ ] **Step 2: Run against your discs**

Run:
```bash
mkdir -p fixtures/local
# copy or symlink decrypted backups: fixtures/local/<Name>/BDMV/...
npx vitest run tests/local
```
Expected: one passing test per disc, each printing a summary line such as `fixtures/local/Movie: main=00800 121.4 min, avc1.640029, audio=83/81, bdj=false`. With no discs present, the suite reports as skipped.

Any failure here is a real-world parsing bug. Debug it with `superpowers:systematic-debugging`, then add a minimal reproduction to the relevant unit test using the builders.

- [ ] **Step 3: Manual playback on your discs**

Run `npm run dev` and open each local disc in Chrome. For each disc, check that:
- (a) the main feature is listed first;
- (b) video plays: discs whose audio is AC-3/DTS/TrueHD play silently with the "can't be played yet" notice;
- (c) seeking with ←/→ and chapter skip land where expected;
- (d) BD-J discs show the BD-J notice.

Record any disc-specific problems in `docs/superpowers/m1-disc-notes.md` (disc name, symptom, console output). They feed M2 and M3.

- [ ] **Step 4: Commit**

```bash
git add tests/local
git commit -m "test: add opt-in checks against local decrypted disc backups"
```

---

## Scope notes (what M1 deliberately leaves for later milestones)

- **`MovieObject.bdmv` parsing, the libbluray-style Navigator API (`playTitle`, `selectStream`), PSR/GPR registers, and the HDMV VM** belong to M3. M1 plays playlists directly through `Player.playPlaylist`, and `Timeline` covers the time math the Navigator will reuse.
- **Audio track switching, the AC-3 WASM decoder, the TrueHD AC-3 core, and trying other codecs through `AudioDecoder.isConfigSupported`** belong to M2. M1 picks the first LPCM track.
- **PG/IG planes, subtitle menus, and SRT/ASS** belong to M3/M4. The compositor already draws through a single `drawVideo` path that later planes will extend.
