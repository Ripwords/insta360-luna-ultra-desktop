<p align="center">
  <img src="app-icon.png" alt="Luna Ultra Desktop" width="160" height="160" />
</p>

<h1 align="center">Luna Ultra Desktop</h1>

<p align="center">
  A desktop companion for the <strong>Insta360 Luna Ultra</strong> camera.
</p>

<p align="center">
  Built with <a href="https://v2.tauri.app/">Tauri 2</a> · <a href="https://nuxt.com/">Nuxt 4</a> · <a href="https://ui.nuxt.com/">Nuxt UI</a> · <a href="https://threejs.org/">Three.js</a>
</p>

<p align="center">
  <a href="https://github.com/Ripwords/luna-ultra-desktop/releases/latest"><img src="https://img.shields.io/badge/Download-macOS-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download for macOS" /></a>
  <a href="https://github.com/Ripwords/luna-ultra-desktop/releases/latest"><img src="https://img.shields.io/badge/Download-Windows-0078D6?style=for-the-badge&logo=windows11&logoColor=white" alt="Download for Windows" /></a>
  <a href="https://github.com/Ripwords/luna-ultra-desktop/releases/latest"><img src="https://img.shields.io/badge/Download-Linux-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Download for Linux" /></a>
</p>

<p align="center">
  <a href="https://github.com/Ripwords/luna-ultra-desktop/releases/latest"><img src="https://img.shields.io/github/v/release/Ripwords/luna-ultra-desktop?style=flat-square&label=latest&color=555" alt="Latest release" /></a>
</p>

Connect over Wi-Fi to drive the camera from a live viewfinder, browse its media library, batch-download photos and videos with the official Luna Ultra watermark, delete files, and explore the camera as an interactive 3D model. Ships as a native desktop app for macOS, Windows, and Linux with signed auto-updates.

Every Luna Ultra feature this app has mapped out is tracked below: what's [shipping](#features), what's [still WIP](#status--whats-still-wip), and what turned out to be unreachable on the camera's control protocol.

<p align="center">
  <img src="screenshots/02-gallery.png" alt="Gallery" width="49%" />
  <img src="screenshots/01-connect.png" alt="Connect" width="49%" />
</p>

## Features

- **Real camera connection** — pairs with the Luna Ultra over its Wi-Fi network using the camera's own TCP control protocol and HTTP media index. No mock data.
- **Camera control** — a live viewfinder with a heads-up display (recording time, storage, resolution, battery), a pro bar for exposure (ISO, shutter, EV, WB), the look (colour mode, Leica and cinematic filters, strength) and format (resolution, framerate, aspect), 1×–12× zoom, six capture modes, and one-tap photo/video capture. See the [feature map](docs/FEATURES.md) for what is verified on-device and what is not.
- **Gallery** — date-grouped grid with photo/video filtering, three thumbnail sizes, and a full-screen preview with metadata and keyboard navigation.
- **Multi-select** — click to toggle, shift-click for ranges, per-day select, and select-all. A floating action bar drives downloads and deletes.
- **Downloads** — a background queue with per-file progress, streamed straight from the camera to your Downloads folder.
- **Official watermark** — applies the genuine Insta360 Luna Ultra watermark asset to photos on download, placed per the camera's real aspect-ratio layout table.
- **Delete** — removes files from camera storage over the control channel (permanent, with a confirmation step).
- **3D showpiece** — the camera rendered from its hi-fi 3D scan with orbit controls, in black or white to match the app theme.
- **Two colorways** — Arctic (light) and Midnight (dark), matching the camera's finishes.
- **Auto-updates** — signed delta updates delivered from GitHub Releases.

## Status — what's still WIP

Everything above is shipping and verified against the camera itself. The camera
has no published API, and its failure mode is silent: it **accepts** a write,
**echoes** it as successful, and **reads back** a value a stale enum renders
under the wrong name. Nothing errors. So a feature only counts here once it has
been set from the app and confirmed on the camera's own screen.

On that bar, this is what is left:

**🧪 Built, gated off** — written and rendering, waiting on on-device verification.

| | Why it's held back |
| --- | --- |
| Full settings panel — stabilisation, format, capture timers, metering, bitrate, RAW | ~30 controls that have never been exercised on the camera. The two that *were* checked properly (colour mode, filters) both turned out to be writing wrong values against a stale schema while reporting success. A panel of confident-looking controls that quietly do the wrong thing is worse than no panel. |
| Live-view diagnostics | Lives inside that same panel. |

**○ Known gaps** — understood, not built.

| | Note |
| --- | --- |
| UltraPhoto capture mode | Sub-mode value unmeasured. Guessing it lands you silently in ordinary Photo mode. |
| Watermarking video | Needs a re-encode; videos currently transfer untouched. |
| White-balance read-back | The write works; the camera reports 10000K regardless, so the dial tracks your last choice. |
| macOS notarization / Windows signing | Needs a paid Apple Developer ID. Until then, macOS installs need one `xattr` command — see [Installing](#installing). |

**⛔ Chased and abandoned** — not reachable on the control protocol.

| | What was tried |
| --- | --- |
| Gimbal pan/tilt control | `PTZ_CTRL` is option type 87, but `Options` has no field 87 — the type has a name and no payload. |
| Gimbal attitude / gyro | `GET_GYRO` is fully defined and answers nothing to any of 20 request shapes. |
| Colour Recovery | Photography *and* device option types 1–400, all 11 named `GET_*` commands, notifications. Nothing moves with the toggle. |
| Deep Track | The field is real and moves when you toggle it on the camera, but writes come back rejected and the value read on connect disagrees with the camera. |
| Tap to focus | No stored option corresponds to it. |

The dividing line is not luck: **everything reachable is a value the camera
stores and reports, and nothing in that last table is.** The one route left for
them is capturing the phone app's traffic.

**[→ Full feature map](docs/FEATURES.md)** — the same picture area by area, with
the measured field numbers, the per-mode availability rules, and the six-step bar
a feature has to clear to ship.

## Screenshots

**Camera control** — a live viewfinder with HUD, the pro bar, zoom, and the mode strip.

![Camera control](screenshots/08-camera.png)

**Connect & 3D showpiece** — pair the camera and inspect it as a hi-fi 3D model.

![Connect and 3D model](screenshots/01-connect.png)

| Gallery | Multi-select |
| --- | --- |
| ![Gallery](screenshots/02-gallery.png) | ![Selection](screenshots/03-selection.png) |

| Download + watermark | Full-screen preview |
| --- | --- |
| ![Download](screenshots/04-download-watermark.png) | ![Preview](screenshots/05-preview.png) |

| Downloads queue | Light theme (Arctic) |
| --- | --- |
| ![Downloads](screenshots/06-downloads.png) | ![Light theme](screenshots/07-gallery-light.png) |

## Installing

Download the installer for your platform from the [latest release](https://github.com/Ripwords/luna-ultra-desktop/releases/latest).

### macOS — "'Luna Ultra Desktop' is damaged and can't be opened"

The app is signed with an ad-hoc key but is **not** yet notarized by Apple, so macOS Gatekeeper quarantines it on download and shows this message. The app isn't actually damaged. Drag it to **Applications**, then clear the quarantine attribute in Terminal:

```bash
xattr -cr "/Applications/Luna Ultra Desktop.app"
```

Then open it normally (or right-click → Open the first time). If you kept the app somewhere other than Applications, point the command at that path instead — for example:

```bash
xattr -cr ~/Downloads/"Luna Ultra Desktop.app"
```

- `xattr -cr` clears **all** extended attributes recursively, which removes the `com.apple.quarantine` flag that triggers the error.
- To remove only the quarantine flag: `xattr -dr com.apple.quarantine "/Applications/Luna Ultra Desktop.app"`.

> The permanent fix is Apple Developer ID signing + notarization (requires a paid Apple Developer account). Once set up, this manual step goes away — see [Releases & auto-updates](#releases--auto-updates).

**macOS local-network permission.** Connecting to the camera at `192.168.42.1` requires macOS's Local Network permission. Allow **Luna Ultra Desktop** the first time it prompts, or enable it under **System Settings › Privacy & Security › Local Network**.

### Windows — "Windows protected your PC" (SmartScreen)

The app isn't signed with a Windows code-signing certificate, so Microsoft Defender SmartScreen warns on first launch. Click **More info → Run anyway**. The MSI installer also shows a standard UAC elevation prompt. No firewall permission is needed — Windows allows the app's outbound connection to the camera automatically (there is no per-app local-network permission like macOS).

### Linux

- **AppImage**: make it executable and run it. Some distributions need FUSE — on Ubuntu 22.04+ install it with `sudo apt install libfuse2`.

  ```bash
  chmod +x "Luna Ultra Desktop_0.1.0_amd64.AppImage"
  ./"Luna Ultra Desktop_0.1.0_amd64.AppImage"
  ```

- **.deb / .rpm**: install with your package manager (`sudo apt install ./*.deb` or `sudo dnf install ./*.rpm`).
- No local-network permission is required to reach the camera.

> Auto-updates apply to the **AppImage** build only. If you installed the `.deb` or `.rpm`, download new releases manually.

## How it connects

The Luna Ultra exposes two services on its Wi-Fi network (default gateway `192.168.42.1`):

- **TCP control (port 6666)** — a UCD2-framed binary protocol used for the auth handshake, device info, and delete commands. A live control session also unlocks the HTTP media index.
- **HTTP (port 80)** — an autoindex-style listing of the camera's storage, plus `Range`-capable file downloads.

The control protocol is implemented in Rust (`src-tauri/src/luna.rs`) and exposed to the frontend as Tauri commands; the HTTP index is parsed on the frontend (`app/utils/lunaIndex.ts`). This protocol was reconstructed from the open-source [`diamondfsd/luna-ai-cut`](https://github.com/diamondfsd/luna-ai-cut) project, which also ships the mock camera server vendored here under `luna_mock_server/`.

## Project layout

```
app/                     Nuxt frontend (pages, components, composables, utils)
  composables/useCamera  Connection lifecycle, auto-reconnect
  composables/useGallery Selection, filtering, delete
  composables/useDownloads  Download queue + watermark compositing
  composables/useUpdater Auto-update checker
  utils/lunaClient.ts    Bridge to the Rust commands + HTTP listing
  utils/lunaIndex.ts     Camera HTTP index parser
  utils/watermark*.ts    Official watermark placement engine
src-tauri/src/luna.rs    Luna Ultra TCP control protocol (Rust)
luna_mock_server/        Camera emulator for development and tests
scripts/probe-*.mjs      On-device protocol probes (calibration, live view, file list)
tests/                   Vitest unit tests
docs/FEATURES.md         Feature map: implemented, gated, and unreachable
docs/superpowers/specs/  Protocol findings of record
screenshots/             Product screenshots
```

## Development

Requires [Bun](https://bun.sh/), [Rust](https://rustup.rs/), and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

```bash
bun install

# Run the full desktop app (Tauri + Nuxt)
bun run dev

# Run just the web frontend in a browser (camera control is unavailable here)
bun run ui:dev
```

> Camera control requires the desktop app — a browser cannot open the raw TCP socket. In `bun run ui:dev` the Connect screen shows a notice explaining this.

### Testing against the mock camera

The vendored `luna_mock_server/` emulates the real Luna Ultra protocol. Point it at a folder of media and connect the app to it:

```bash
node luna_mock_server/server.mjs \
  --root /path/to/media --host 127.0.0.1 --http-port 18080 --tcp-port 6666
```

Then launch `bun run dev` and connect to `127.0.0.1:18080` from the Connect screen.

### Quality checks

```bash
bun x vitest run                                   # frontend unit tests
bun run typecheck                                  # Nuxt/vue-tsc
bun run lint                                       # oxlint
cargo test --manifest-path src-tauri/Cargo.toml    # Rust protocol + integration tests
```

## Building

```bash
bun run build
```

Bundles land in `src-tauri/target/release/bundle/`.

## Releases & auto-updates

Cutting a release is one command:

```bash
bun run release
```

This uses [`changelogen`](https://github.com/unjs/changelogen) to determine the next version from your [Conventional Commits](https://www.conventionalcommits.org/), update `CHANGELOG.md`, sync that version into `package.json`, `src-tauri/tauri.conf.json`, and `Cargo.toml`, then commit, tag, and push. (Force a specific bump with `bun run release -- --patch` / `--minor` / `--major`.)

Pushing the tag triggers `.github/workflows/release.yml`, which:

1. Opens a **single** GitHub Release with notes generated by `changelogen` (the previous duplicate-release problem is solved by creating the release once, up front).
2. Builds and signs bundles for macOS (Apple Silicon + Intel), Windows, and Linux with [`tauri-action`](https://github.com/tauri-apps/tauri-action), uploading each to that one release along with the `latest.json` update manifest.
3. Publishes the release once every platform succeeds (a failed platform leaves it as a draft for inspection).

The app checks for updates on launch and hourly, showing an install prompt in the sidebar when one is available (`app/composables/useUpdater.ts`).

> To preview the notes for the next release without cutting it, run `bun run changelog` (writes `CHANGELOG.md`).

### One-time setup

1. **Updater endpoint.** In `src-tauri/tauri.conf.json` the endpoint must point at your repo (already set to `Ripwords/luna-ultra-desktop`):

   ```json
   "endpoints": ["https://github.com/<owner>/luna-ultra-desktop/releases/latest/download/latest.json"]
   ```

2. **Signing keys.** A keypair has already been generated. The public key is committed in `tauri.conf.json`; the private key is in `src-tauri/luna-ultra-updater.key` and is git-ignored. Add it as a repository secret (the key has no password, so only the first is required):

   - `TAURI_SIGNING_PRIVATE_KEY` — the full contents of `src-tauri/luna-ultra-updater.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — omit for a passwordless key

   ```bash
   gh secret set TAURI_SIGNING_PRIVATE_KEY < src-tauri/luna-ultra-updater.key
   ```

   To rotate the key, run `bun x tauri signer generate -w src-tauri/luna-ultra-updater.key` and paste the new public key into `tauri.conf.json`.

   > **Keep the private key safe.** If it is lost, existing installs can no longer verify updates.

## Credits

Camera protocol and the official watermark assets are derived from [`diamondfsd/luna-ai-cut`](https://github.com/diamondfsd/luna-ai-cut). Insta360 and Luna Ultra are trademarks of their respective owners; this is an unofficial companion app.
