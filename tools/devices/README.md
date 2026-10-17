# devices: Safari automation on iPhone, iPad and the iOS Simulator

Scripts that open the player or the device probe in Safari on a real iPhone or iPad (over USB) or on an iOS Simulator, wait for a condition, read telemetry, tap, take screenshots and collect console logs. Spec: `docs/superpowers/specs/2026-10-17-m5d-bdj-menus-design.md` §4.5.

They speak W3C WebDriver to [Appium](https://appium.io) with the XCUITest driver. Appium runs Safari's remote inspector for the page (scripts, console) and WebDriverAgent, a helper app it builds with Xcode, for touches and screenshots. Taps are real touches, so they count as the user gesture the player needs to start audio.

The Simulator needs no setup beyond Xcode. A real device needs the one-time setup below.

## Install Appium (once per checkout)

Appium and its driver live in `.cache/appium` (gitignored), not in `package.json` and not globally:

```sh
npm install --prefix .cache/appium appium@3.8.0
APPIUM_HOME="$PWD/.cache/appium" .cache/appium/node_modules/.bin/appium driver install xcuitest@12.18.1
```

npm skips Appium's `postinstall` (it only auto-installs extensions from an environment variable); that is fine. The scripts start this Appium themselves when nothing answers at `$APPIUM_URL` (default `http://127.0.0.1:4723`), and stop it afterwards. The first session on a device builds WebDriverAgent (a few minutes); later ones start in about 30 s.

## Run

```sh
npm run build
npm run disc-server -- --root fixtures/synthetic                      # Simulator: plain HTTP on 127.0.0.1 is enough
npx tsx tools/devices/probe.ts --device "sim:iPhone 17" --server http://127.0.0.1:8080 \
  --token <token the server printed> --disc disc1 --out probe.json --screenshot probe.png
npx tsx tools/devices/run.ts --device "sim:iPhone 17" \
  --url "http://127.0.0.1:8080/?telemetry=1&disc=<disc URL>&token=<token>" \
  --until "document.querySelector('[data-testid=server-discs] button')" \
  --tap-on "[data-testid=server-discs] button" \
  --until "document.querySelector('[data-testid=playlist-00000]')" --tap-on "[data-testid=playlist-00000]" \
  --until "window.__blurayTelemetry?.framesPresented > 30" \
  --telemetry telemetry.json --screenshot playing.png --console console.txt
```

`--device` is `sim:<name>` (as `xcrun simctl list devices available` names it; the newest runtime wins and the Simulator is booted if needed) or a real device's UDID (`xcrun xctrace list devices`). `run.ts` runs its steps in the order given: `--until <js>` (polls until truthy; `--timeout <ms>`, default 60000), `--tap x,y` (page coordinates, the CSS pixels of `clientX`/`clientY`), `--tap-on <css selector>`, `--wait <ms>`, `--screenshot <png>`, `--telemetry <json>` (`window.__blurayTelemetry`; the URL needs `?telemetry=1`), `--eval <js>` (prints the value; a promise is awaited); `--console <txt>` writes Safari's console log at the end.

`probe.ts` opens `probe.html?disc=<disc URL>&token=<token>`, which probes a disc on the disc server instead of a picked folder: the "Blob slicing over 4 GiB" row is then an HTTP range read past 4 GiB (its detail starts with `server:`), and the HEVC row decodes the disc's first HEVC GOP read over HTTP. For a real device use the server's HTTPS LAN origin (`--server https://<lan-ip>:8443`) and run with `NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"` so the script can read the server's disc list. The USB route (a folder picked in Files) needs a person to pick the folder: open `https://<lan-ip>:8443/probe.html` on the device and tap "Pick a disc folder".

## One-time setup for a real iPhone or iPad

Xcode must be installed with its licence accepted (`sudo xcodebuild -license accept`). Then, for each device:

1. **Trust this Mac.** Connect the device by USB-C, unlock it and tap Trust, entering the passcode. `xcrun xctrace list devices` then lists it with its UDID.
2. **Developer Mode.** Settings → Privacy & Security → Developer Mode → on; the device restarts; confirm Turn On after it unlocks. (The switch only appears after the device has been connected to a Mac with Xcode; if it is missing, open Xcode → Window → Devices and Simulators once with the device connected.)
3. **Web Inspector and Remote Automation.** Settings → Apps → Safari → Advanced → turn on Web Inspector (Safari's remote inspector, used for scripts and console logs; also lets you inspect the page from Safari on the Mac, Develop menu) and Remote Automation.
4. **Apple ID in Xcode.** Xcode → Settings → Accounts → + → Apple ID. A free Apple ID gives a "Personal Team"; note its Team ID (shown as `(Personal Team)` with a 10-character ID in the account's team list or in a signing error).
5. **Sign WebDriverAgent with the personal team.** Open the driver's project:
   ```sh
   APPIUM_HOME="$PWD/.cache/appium" .cache/appium/node_modules/.bin/appium driver run xcuitest open-wda
   ```
   In Xcode select the `WebDriverAgentRunner` target → Signing & Capabilities: tick "Automatically manage signing", choose your Personal Team, and change the bundle identifier to something unique to you (for example `com.<yourname>.WebDriverAgentRunner`; a free team cannot use `com.facebook.*`). Do the same team for the `WebDriverAgentLib` target. Select your device as the run destination and press ⌘U (Product → Test) once; it fails to launch the first time.
6. **Trust the developer certificate on the device.** Settings → General → VPN & Device Management → your Apple ID under Developer App → Trust. Run ⌘U again; WebDriverAgent starts on the device (the screen shows "Automation Running"). Stop it in Xcode.
7. **Tell the scripts** your team and bundle identifier through the environment, never in the repository:
   ```sh
   export DEVICE_TEAM_ID=<your team ID>
   export WDA_BUNDLE_ID=com.<yourname>.WebDriverAgentRunner
   ```
8. **The disc server's certificate.** Make the mkcert certificate as in `tools/disc-server/README.md`, then AirDrop `"$(mkcert -CAROOT)/rootCA.pem"` to the device, open it (Settings shows "Profile Downloaded"; Settings → General → VPN & Device Management → install it), and turn on full trust: Settings → General → About → Certificate Trust Settings → the mkcert root → on. Check by opening `https://<lan-ip>:8443/` in Safari on the device: no certificate warning. The device must be on the same Wi-Fi as the Mac.

**Every 7 days:** a free team's provisioning profile expires after 7 days and WebDriverAgent stops launching ("profile has expired" or the app closes at once). Re-sign: connect the device, open the project as in step 5 and press ⌘U again (Xcode renews the profile), or delete WebDriverAgentRunner from the device first if Xcode complains. A free team is also limited to 3 devices and 10 app IDs per week, which is enough here.

If Appium cannot find a connected device running iOS 17 or later, start the driver's device tunnel in another terminal (it needs root) and retry:

```sh
sudo APPIUM_HOME="$PWD/.cache/appium" .cache/appium/node_modules/.bin/appium driver run xcuitest tunnel-creation
```

## The Simulator

Nothing to set up: WebDriverAgent needs no signing there, and the Simulator shares the Mac's network, so plain HTTP on `127.0.0.1` is a secure context and the disc server needs no certificate. To test HTTPS there anyway, add the mkcert root with `xcrun simctl keychain booted add-root-cert "$(mkcert -CAROOT)/rootCA.pem"`. Simulator Safari runs on the Mac's media stack and CPU, so codec support and timings there say nothing about the real devices.

## Not here

Device UDIDs, Apple IDs, team IDs, certificates and tokens stay out of the repository: pass them on the command line or in the environment.
