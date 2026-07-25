# Feature map — what's mapped, what's implemented, what's still WIP

The Luna Ultra has no published API. Everything this app does was reconstructed
from the [`diamondfsd/luna-ai-cut`](https://github.com/diamondfsd/luna-ai-cut)
protocol extraction and then **re-measured against the real camera**, because the
extraction describes a 2020-era device and this one has drifted from it.

That drift is the reason this page exists. The camera's failure mode is silent:
it **accepts** a write, **echoes** the option type as successful, and **reads
back** a value that a stale enum renders under the wrong name. Nothing errors.
So "the code sends it" is not evidence a feature works — only the camera's own
screen is. Everything below is graded on that bar.

- **Measured against:** Insta360 Luna Ultra, firmware **v1.0.238** (Colour
  Recovery notes are from **v1.0.283**)
- **Measurement tooling:** `scripts/probe-colorspace.mjs`
- **Findings of record:** [`specs/2026-07-25-camera-protocol-calibration.md`](superpowers/specs/2026-07-25-camera-protocol-calibration.md)
- **Test suite:** 259 unit tests across 17 files, plus Rust protocol/integration tests

## Legend

| | Meaning |
|---|---|
| ✅ | **Shipping.** In the packaged release, verified on-device. |
| 🧪 | **Dev-only.** Built, but behind a flag in `app/utils/features.ts` that is off in release builds. |
| 🚧 | **Partial.** Works, with a known limitation stated in the row. |
| ⛔ | **Blocked.** Investigated and found unreachable on this protocol — see [Not reachable](#not-reachable-on-this-protocol). |
| ○ | **Not started.** Understood, not built. |

---

## Connection & session

| Feature | Status | Notes |
|---|---|---|
| TCP control handshake (port 6666, UCD2 framing) | ✅ | Rust, `src-tauri/src/luna.rs`. Auth handshake + device info. |
| HTTP media index (port 80) | ✅ | A live control session is what unlocks it. |
| File listing via `GET_FILE_LIST` | ✅ | Replaced HTML autoindex scraping, which firmware 1.0.238 dropped. |
| Auto-reconnect with backoff | ✅ | 1s → 2s → 5s → 10s → 15s, repeating; retries immediately on OS `online`. |
| Health detector / forced disconnect | ✅ | 3 consecutive failed requests plus a failed probe drops the session and leaves it dropped. |
| Manual host override | ✅ | Persisted; accepts `host:port` for the mock server. |
| Request queue with priority + concurrency cap | ✅ | 4 slots, priority-ordered (thumbnail < listing < preview), pausable so a full-screen open is not queued behind a grid of thumbnails. |
| Device readout (serial, firmware, storage, battery) | ✅ | Settings page + viewfinder HUD. |

## Live view

| Feature | Status | Notes |
|---|---|---|
| OSC MJPEG preview | ✅ | Probed first; used when the camera offers it. |
| Control-session H.264 stream | ✅ | `START_LIVE_STREAM` → Rust bridges the socket to a local HTTP port. |
| Annex-B → WebCodecs decode to canvas | ✅ | NAL splitting, access-unit assembly, keyframe gating in `app/utils/annexB.ts`. |
| Preview auto-start / auto-stop | ✅ | Starts on connect, releases the camera's single HTTP connection before navigation. |
| Stream diagnostics | 🧪 | Inside the settings slide-over, which is gated with `allSettings`. |
| Preview resolution control | ○ | Preview arrives flat at 1280×960; no lever found for it. |

## Capture

| Feature | Status | Notes |
|---|---|---|
| Mode strip — Video, Pure, Slow-mo, Photo, Pano, Timelapse | ✅ | Sub-mode values re-measured; the extraction's Pano value (5) was wrong, it is **8**. |
| Pano HDR | ⛔ | Defined in the extraction, **does not exist** on this camera. Removed. |
| Record start/stop with the right capture mode | ✅ | Per-mode `Capture_MODE_*`, not one generic start. |
| Stills capture (`TAKE_PICTURE`) | ✅ | Photo and Pano. |
| Recording status + elapsed timer | ✅ | Polled at 1 Hz from the camera's own status, not a local stopwatch. |
| Adopt the mode the camera is already in | ✅ | Also re-points the settings layer at that mode's option set — settings are stored **per function mode**, so a stale one silently writes to the wrong mode and the read-back agrees with itself. |
| Forced reset on entering Standard-only modes | ✅ | Pure / Slow-mo / Timelapse / Pano get `color_mode = Standard`, `gamma_mode = none` written on entry. The camera does not do this for you. |
| UltraPhoto sub-mode | ○ | Value unmeasured. Guessing it would land you silently in ordinary Photo. |
| Self-timer / AEB / burst | 🧪 | Declared in `cameraControls.ts`, never exercised on-device. |

## Camera settings — the pro bar

The always-visible strip over the viewfinder. Every chip here writes, reads
back, and shows a per-field verdict: ✔ applied · ⇄ differs · ? assumed
(proto3 omits defaults, so silence is ambiguous) · ✕ rejected.

| Chip | Field / option type | Status | Notes |
|---|---|---|---|
| ISO | `video_exposure` / `still_exposure` | ✅ | The real lever is per-channel `ExposureOptions`, **not** the legacy `exposure_manual` (accepted, then reverts). |
| Shutter | `video_exposure.shutter_speed` (seconds) | ✅ | ISO/shutter auto-state picks the program like a PASM dial: MANUAL / ISO_PRIORITY / SHUTTER_PRIORITY / AUTO. |
| EV | `exposure_bias` | ✅ | ±4 EV in 1/3 stops. |
| Color | `color_mode` (field 35) | ✅ | **Re-measured:** Standard=1, i-Log=2, Dolby Vision=5. The extraction said 0/1/2/3 with a VIVID that does not exist — which is how the app claimed i-Log for months while shooting Standard. |
| Filter | `gamma_mode` (field 18) | ✅ | The extraction calls this a gamma curve. It is the **Filter** picker: Original, 3 Leica profiles, 6 cinematic looks. Numbering is non-contiguous (Leica Chrome is 36). |
| Strength | `filter_intensity` (field 104) | ✅ | Does not exist in the extraction at all; found by scanning option-type numbers past the end of the enum. Cinematic filters only. |
| Res / FPS / Ratio | `record_resolution` | ✅ | Three axes rather than one 37-entry list. Each choice is re-solved against what exists, so you can't strand on 8K120. |
| WB | `white_balance` + `white_balance_value` | 🚧 | Write works. Read-back is unreliable — the camera reports 10000K regardless — so the wheel tracks the last choice made. |
| Sharpness | `sharpness` | ✅ | Note that a colour-mode change **rewrites** this, so colour writes force a full re-read. |
| Aspect (Pano only) | `pano_aspect` (field 98) | ✅ | 360=1, 2:1=4. Separated from three co-travelling fields with a negative control. |
| Zoom | `zoom_scale` | ✅ | 1×–12×, mouse wheel over the picture or a drag dial. Blind throttled writes during the gesture, one verified write on release. |

**Availability gating.** `$supported` cannot drive this UI — the camera lists an
option type as supported anywhere it will merely *parse* it, including modes
whose own screen has no such picker. So the rules come from the manual and
on-device checks, in `app/utils/cameraCapabilities.ts`:

| Capture mode | Colour modes | Filters | Resets on entry |
|---|---|---|---|
| Video | Standard, i-Log, Dolby Vision | yes (not in DV) | no |
| Pure | Standard only | yes | **yes** |
| Slow-mo | Standard only | yes | **yes** |
| Timelapse | Standard only | yes | **yes** |
| Photo | no picker | yes | no |
| Pano | no picker | — | **yes** |

Filters additionally need 4K@60 or lower. The manual lists Dolby Vision as
filter-supporting; the camera disagrees, and the camera wins.

**Resolutions.** 37 measured entries — 8K/4K/3K 1:1/2.7K/1080p, 2.35:1 and 9:16
crops, 24–240fps. The `VideoResolution` enum's 229 entries are *not* used as the
source: most describe a different camera. The list only grows by measurement,
and `PENDING_RESOLUTIONS` is currently empty — every number seen on the wire has
been named off the camera's screen.

## Camera settings — the full panel

🧪 **Off in every build** (`FEATURES.allSettings = false`), reachable neither
from MORE in the pro bar nor the header sliders button.

The panel is written and renders every option the camera acknowledges. It is
gated because most of those controls have **never been exercised on-device**,
and the two that were checked properly — colour mode and filters — both turned
out to be writing wrong values against a stale schema *while reporting success*.
A panel of confident-looking controls that quietly do the wrong thing is worse
than no panel.

| Section | Controls | Status |
|---|---|---|
| Exposure | Exposure mode, metering, metering enable, ISO ceiling | 🧪 unverified |
| Colour | WB preset, colour temperature, colour mode, filter, filter strength, flicker, brightness, contrast, saturation, hue, sharpness | 🧪 partly verified — colour/filter/strength/sharpness are proven via the pro bar; the rest are not |
| Format | Video resolution, photo size, FOV, RAW capture, bitrate | 🧪 unverified |
| Capture | Self-timer, AEB frames, burst frames, burst window, pre-record cache | 🧪 unverified |
| Stabilisation | FlowState, low-light EIS, sport-mode preview, preview noise reduction | 🧪 unverified |
| Device | Mute microphone | 🧪 unverified |

**To ship this:** verify each control the way colour mode was verified — set it
from the app, read the camera's own screen, and confirm they agree — then flip
the flag. Partial verification is possible: the section could ship a row at a
time.

## Gallery & media

| Feature | Status | Notes |
|---|---|---|
| Date-grouped grid | ✅ | |
| Photo / video filter | ✅ | |
| Internal vs SD card filter | ✅ | Only appears once the camera reports SD-card files. |
| Three thumbnail sizes | ✅ | |
| Multi-select: click, shift-range, per-day, select-all | ✅ | |
| Full-screen preview with metadata + keyboard nav | ✅ | |
| Viewport-directed thumbnail loading | ✅ | Opened item first, then outward. |
| Session LRU media cache | ✅ | Caches the *derived* artifact (display blob / decoded preview), not the multi-MB source. |
| Video thumbnails & playback | 🚧 | The camera's LRV proxies are H.264/MP4 despite the extension; MIME is forced. WKWebView will not decode `blob:` video, so playback streams direct. |
| 360 / pano viewer | ✅ | Pannellum. The Luna tags 360s with neither a `PANO_` name nor GPano metadata, so detection is by 2:1 aspect plus a megapixel window — which correctly excludes the 200MP stitched panorama (2:1 but flat, not a sphere). |
| DNG / RAW preview | ✅ | Luna DNGs carry **no embedded JPEG** — raw 16-bit Bayer only. A pure-TypeScript subsample-demosaic-gray-world pipeline renders a recognisable preview. No copyleft RAW library. |
| Delete from camera storage | ✅ | Over the control channel, with confirmation. Permanent. |
| Rename / move / in-app trash | ○ | Not attempted. |

## Downloads & watermark

| Feature | Status | Notes |
|---|---|---|
| Background download queue with per-file progress | ✅ | |
| Streamed straight to the Downloads folder | ✅ | |
| Retry failed transfers, clear finished | ✅ | |
| Official Luna Ultra watermark on photos | ✅ | The genuine Insta360 asset, placed per the camera's real aspect-ratio layout table. |
| Watermark settings + reset | ✅ | Settings page. |
| Watermark on video | ○ | Videos transfer untouched — this needs a re-encode, which is a different piece of work entirely. |

## App shell

| Feature | Status | Notes |
|---|---|---|
| Arctic (light) / Midnight (dark) colourways | ✅ | Matching the camera's finishes. |
| 3D camera model with orbit controls | ✅ | From the hi-fi scan, black or white to match the theme. |
| Signed auto-updates | ✅ | Checked on launch and hourly; delta updates from GitHub Releases. |
| macOS notarization | ○ | Signed ad-hoc only — needs a paid Apple Developer ID. Until then, `xattr -cr`. |
| Windows code signing | ○ | SmartScreen warns on first launch. |
| Mock camera server for dev/tests | ✅ | Vendored under `luna_mock_server/`. |

---

## Not reachable on this protocol

Five features were driven successfully; five were chased and abandoned. The
split is not luck — it is the shape of what the control protocol exposes.

**Everything reachable is a value the camera stores and reports. Nothing in this
list is.** Before spending a day on the next feature, ask which column it is in.

| Feature | Status | What was tried |
|---|---|---|
| Colour Recovery (v1.0.283) | ⛔ | Photography option types 1–400, device option types 1–400, all 11 named `PHONE_COMMAND_GET_*`, `GET_SUBMODE_OPTIONS` in 16 request shapes, unsolicited notifications. Nothing moves with the toggle. It visibly changes the preview, so it is real — just not observable here. |
| Gimbal pan/tilt control | ⛔ | `PTZ_CTRL` is option type 87 and the only pan/tilt name in the schema, but `Options` has **no field 87** — the type has a name and no payload, so it answers empty. |
| Gimbal attitude / gyro | ⛔ | `PHONE_COMMAND_GET_GYRO` is fully defined and answers nothing to any of 20 request shapes. `NotificationCameraPostureUpdate` carries only ROTATE_0/90/180/270/UP/DOWN — "is it upside down", not an angle. |
| Deep Track | 🚧 ⛔ | Field 91 is real: toggling it on the camera drives a nested `state` 2 ↔ 5. But writes come back `differs`, and the value read on connect did not match the camera. Status we cannot interpret is not a control, so there isn't one. |
| Tap to focus | ⛔ | No stored option corresponds to it. |

The one remaining route for all of these is capturing the phone app's traffic
(`scripts/decode-capture.mjs`) — those commands demonstrably exist, since the
phone issues them; they just never touch anything readable.

**Deliberately not done:** command codes above 152 were never scanned. This
firmware certainly has them, but an unnamed code could be a setter, a format or
a reset, and a read-only probe has no business firing one blind.

---

## How something moves from WIP to shipped

The bar, in order. Skipping step 2 is what produced every wrong value listed on
this page.

1. **Find the lever.** `node scripts/probe-colorspace.mjs pair <before> <after> --all`
   — snapshot, change one thing on the camera, snapshot, diff. Use `series` for a
   list of values, `scan --max 200` when the setting has no field in the schema
   at all. Never run two `snapshot`s from one paste; the diff will truthfully
   report that nothing moved.
2. **Confirm against the camera's own screen.** Set it from the app, then look at
   the camera. A write that is accepted, echoed and read back is *not* evidence.
3. **Record the numbers** in `scripts/build-schema.mjs` overrides and re-run it.
4. **Encode the availability rules** in `app/utils/cameraCapabilities.ts`, with
   the manual page or the on-device check that established them.
5. **Write the test**, then wire the control.
6. **Flip the flag** in `app/utils/features.ts`.

Re-run `node scripts/probe-colorspace.mjs calibrate` after any firmware update.
It is one read-only pass that prints a paste-ready override block.

## Next up, roughly in order

1. **Verify the full settings panel section by section** and open `allSettings`.
   Stabilisation and Format are the highest-value rows.
2. **Measure the UltraPhoto sub-mode value**, the last unmeasured capture mode.
3. **Capture the phone app's traffic** — the only route left to gimbal control,
   tap-to-focus and Colour Recovery.
4. **Apple Developer ID signing + notarization**, which removes the `xattr` step
   from installation entirely.
