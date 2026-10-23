# Local Network Access results (step 2, task 2)

Date: 2026-10-17. This spike decides where remote disc reads run: in the engine worker or on the main thread.

## Setup

- Server: `https://nas.example.com/bluray/api/health` (the NAS's Tailscale name), which resolves to a Tailscale CGNAT address. Every browser classed it as a local or private address and applied its local-network checks.
- Probe page: `https://device-test.bluray-web.pages.dev/lna` (`public/lna.html` and `public/lna-worker.js` on the throwaway `device-test` branch, commit 450d171). It runs under the app's COOP/COEP (`require-corp`), with `crossOriginIsolated` true everywhere. Pressing Run (a user gesture) fetches health from the page and from a module worker, once as a plain GET and once with `Range: bytes=0-15`. `?order=worker` runs the worker first, so the worker's request reaches the browser before any request from the page. Results are exposed as `window.__lna`.
- Drivers: Playwright `channel: 'chrome'` with a persistent context (headed and headless), geckodriver (Firefox, with `--allow-system-access` so the prompt could be read and answered from the browser chrome), and safaridriver (Mac Safari and the iPad).

## Results

| Browser / device | Page fetch | Worker fetch | Prompt shown? | Works after granting? |
|---|---|---|---|---|
| Chrome 155.0.8059.80, macOS, headed | Hangs until answered | Hangs until answered | Yes: "device-test.bluray-web.pages.dev wants to Access other devices on your local network" (Block / Allow). The worker's request triggers it too (worker-first run) | Yes. With `local-network-access` granted, page and worker both returned 200 in both orders (15–84 ms). The grant came from `context.grantPermissions(['local-network-access'])` (`'local-network'` and `'loopback-network'` are rejected as unknown); a click on the real Allow button couldn't be automated (no accessibility access) |
| Chrome 155, headless | `TypeError: Failed to fetch` at once | `TypeError: Failed to fetch` at once | No prompt; denied by default | Yes. With `grantPermissions(['local-network-access'])` all four fetches returned 200 |
| Firefox 158.0, macOS | Hangs until answered (`network.lna.prompt.timeout` 300000 ms) | Hangs until answered | Yes: the "local-network" doorhanger, "<origin> wants to access apps and services on devices connected to your local network." (Allow / Block). The worker's request raises it too | Yes. Allow (the prompt's own main action) gave 200 for the worker and the page; Block gave `TypeError: NetworkError when attempting to fetch resource.` The `local-network` permission state goes from `prompt` to `granted` or `denied` |
| Safari 26.6.2, macOS | 200 (53 ms) | 200 (16 ms) | No | n/a (no permission; `permissions.query` doesn't know any of the names) |
| iPad Pro 12.9 (5th gen), Safari, iPadOS 27 (UA `Version/27.0.1`) | 200 (21–57 ms) | 200 (13–53 ms) | No | n/a; page-first and worker-first both pass |
| iPhone 17 Pro, Safari | Not run | Not run | — | safaridriver: "could not connect to device" on four tries (the iPad on the same driver worked) |

All four variants (page or worker, plain or Range) behaved the same in every browser. Preflight: the server doesn't log requests, so whether `Range: bytes=0-15` caused a preflight wasn't observed. The Range GETs succeeded everywhere, and the server answers preflights that allow `Range` anyway. The health endpoint ignores Range (200, no `Content-Range`), so a real range read against a file waits for Task 6.

## Decision

**`transport: 'worker'`**

Every browser that ran reached the server from a module worker with at most one prompt. Safari on the Mac and the iPad shows no prompt. Chrome and Firefox show one prompt per origin, and the worker's own request raises it, so the worker doesn't need the page to fetch first. Once the prompt is allowed, worker fetches succeed and the permission reads `granted` (how long the grant lasts across sessions wasn't measured). Nothing here favours the main thread: it gets the same prompt, the same hang and the same denial as the worker. The worker keeps reads beside the demuxer with no extra hop. Chrome doesn't block without a way to grant, so there is nothing to escalate. The iPhone wasn't measured. It runs the same WebKit as the iPad, which passed, so the ruling doesn't wait for it, but it should be checked when the device is reachable.

## Consequences for Task 8

- While the Chrome or Firefox prompt is unanswered, the fetch neither resolves nor rejects (Chrome was still pending after 70 s; Firefox waits up to 300 s). The first connection needs a timeout or a "waiting for local network permission" hint in the UI, and it should be started from a user gesture (the probe always was; prompting without one wasn't tested).
- A Block shows up as a plain fetch `TypeError` (Chrome: `Failed to fetch`; Firefox: `NetworkError when attempting to fetch resource.`), the same as an unreachable server. Where `navigator.permissions.query({ name: 'local-network-access' })` (Chrome) or `{ name: 'local-network' }` (Firefox) returns `denied`, use it to tell the two apart. Safari supports neither name.
- Headless Chrome E2E runs need `context.grantPermissions(['local-network-access'])`, or every NAS fetch fails at once.
