# Webcam mode (Stream to OBS) and preview-stream fixes

Date: 2026-11-07
Status: draft for approval

## Why

Enough users ask to use the Luna Ultra as a webcam that it is worth shipping
even with the preview's latency. The camera has no webcam mode of its own:
Insta360's manual says webcam use is "not currently supported", USB enumerates
as mass storage only, and no Insta360 live-streaming or RTMP route is
documented for the Luna Ultra (checked 2026-11-07).

The owner wants this on macOS, Windows and Linux. A native virtual camera per
OS is large, and on macOS it cannot ship without a paid Developer ID. OBS
already ships a signed virtual camera on all three, so the app's job is to
hand OBS a stream it can play. One Rust implementation then covers every
platform.

The same release fixes preview-stream bugs that a public fork
(Defib-TDE/insta360-luna-ultra-desktop, branch `feature/webcam-bridge`) found
in our code. A long-running webcam stream would hit them far more often than
the viewfinder does today. That fork has no licence, so nothing is copied from
it. Only its findings are used.

## What the user sees

1. On the camera page, a **Webcam mode** toggle sits with the viewfinder
   controls.
2. When it is on, a panel shows the stream address
   (`http://127.0.0.1:<port>/webcam.ts`) with a copy button, a live status
   (Streaming / Waiting for camera / Camera stopped sending), and a link to
   the setup guide.
3. In OBS, they add a Media Source with that address, then click
   **Start Virtual Camera**. Zoom, Meet, Teams and Discord then list
   "OBS Virtual Camera".
4. Webcam mode keeps streaming whatever page is open. It stops when the user
   turns it off, disconnects, or the camera connection drops for good.
5. The sidebar and the camera status chip show that webcam mode is on, so a
   user on another page knows the camera is busy.

## Goals

- One Rust implementation, the same on all three OSes. No per-OS code paths
  for the stream.
- OBS plays the stream with no extra settings beyond pasting the URL. Turning
  off "Restart playback when source becomes active" is acceptable as a
  documented tip.
- OBS can join, leave and rejoin at any time and get a clean picture straight
  away.
- The stream survives camera mode changes, which change its resolution and
  orientation mid-stream (measured by the fork: 1280×720 in most modes,
  720×1280 in Photo, Video and Pure, 1280×960 at ~24 fps in Timelapse).
- A silent stall, where the camera stops sending video while the control
  connection stays up, is detected and explained to the user instead of
  freezing without a word.
- Fix the preview bugs listed below, for the viewfinder and the webcam
  stream alike.

## Non-goals

- Native virtual cameras (CoreMediaIO, Media Foundation, v4l2loopback). These
  can come later and reuse the Rust stream; nothing here should block them.
- Audio. The preview stream has none.
- Higher resolution than the camera's preview. The camera acknowledges
  1080p and 4K preview requests but still sends 720p (fork, firmware v1.1.15).
- Cropping, scaling, overlays or frame-rate conversion. OBS does all of that.
- Remote access. The stream binds to 127.0.0.1 only.
- RTMP, SRT or RTSP output.

## Anti-goals: failure even if it technically works

- The webcam picture smearing or going grey when OBS joins mid-stream, or after
  a mode change.
- The camera being force-disconnected because webcam mode and the gallery
  fought over it.
- The app showing "Streaming" while the camera has silently stopped sending.
- A different code path per OS for the stream.

## Constraints

- No new runtime dependencies for users beyond OBS, which they install
  themselves.
- No decoding in Rust. The app only repackages the camera's H.265 (or H.264,
  if the camera ever sends it) into MPEG-TS.
- No new Rust crates unless one is clearly better than about 300 lines of
  muxer code. MPEG-TS packing for one video stream is small and fully
  testable against `ffprobe`.
- Project rules apply: TDD, oxfmt and oxlint clean, Vue conventions from
  CLAUDE.md, readable text at least `text-sm`, no `window.confirm`, and the
  manual updated in the same change.

## How: decided

### Rust owns one preview stream, with consumers counted

Today the webview starts and stops the camera's preview directly
(`luna_liveview_start` / `luna_liveview_stop`), and the camera page stops it on
route leave. That changes:

- `LiveViewState` holds the camera-side preview (`START_LIVE_STREAM` sent once)
  and a set of active consumers: `viewfinder` and `webcam`.
- START is sent when the first consumer arrives. STOP is sent when the last
  one leaves.
- The viewfinder still releases its claim on route leave. If webcam mode is
  on, that no longer stops the camera's preview.
- On disconnect, both consumers end and the webcam state reports "stopped:
  camera disconnected". If the app's auto-reconnect succeeds, webcam mode
  resumes on its own: the user asked for it and has not turned it off.

### Relay fixes (both the viewfinder and webcam outputs)

1. **UCD2 framing split across reads** (`src-tauri/src/luna.rs:196`).
   `drain_frames` clears the buffer when no full magic is present, which drops
   a trailing `U`, `UC` or `UCD` and loses the next frame. Keep up to 3
   trailing bytes that are a prefix of the magic. Test: feed a known stream
   split at every byte offset and assert identical frames.
2. **Lagging clients** (`src-tauri/src/liveview.rs:120`). On
   `RecvError::Lagged` the relay currently continues, which hands the decoder a
   stream with a gap. Instead, close that client. The viewfinder reconnects and
   the webcam's OBS source reconnects; both rejoin cleanly via item 3.
3. **Late joiners get a decodable start.** The relay caches the latest
   parameter sets (VPS/SPS/PPS for H.265, SPS/PPS for H.264) and every access
   unit since the last keyframe (IDR/CRA/BLA for H.265, IDR for H.264). The
   cache is capped at 16 MB; past the cap it is dropped until the next
   keyframe. A new client gets parameter sets, then the cached group, then the
   live stream. When parameter sets change, the cache resets.
4. **Keepalive while video flows.** While video data arrived within the last
   12 s, skip the keepalive queries; video arriving proves the camera is alive.
   Put a 3 s timeout on control-socket writes so a wedged write cannot hang the
   session.
5. **Health detector staleness** (`app/utils/cameraHealth.ts:82`). Replace the
   callback-identity check with a revision counter, so re-arming with the same
   callback cannot leave a stale timer active.

### Webcam output: MPEG-TS over HTTP

- A second endpoint on a **fixed** localhost port: 49283 for us, chosen to
  avoid the fork's 49183. If that port is taken, fall back to a random port
  and show the actual one. The address is shown in the UI and is stable
  between sessions when the port is free.
- Path `/webcam.ts`, `Content-Type: video/mp2t`.
- A minimal MPEG-TS muxer in Rust:
  - PAT and PMT, repeated every 100 ms and before every keyframe.
  - One video PID; stream type 0x24 for H.265 and 0x1B for H.264, chosen from
    the NAL headers.
  - PES packets with PTS (and DTS equal to PTS; the preview has no B-frames.
    The plan verifies this with ffprobe on a capture and keeps a DTS ≠ PTS
    path out of scope unless one shows up).
  - PCR on the video PID.
- **Timestamps come from arrival time**, on a 90 kHz clock started at stream
  start, not from a fixed 30 fps. Timelapse at ~24 fps and any jitter then
  stay correct.
- **Access units.** Split the elementary stream into access units by NAL
  type, not by UCD2 payload, because one payload has not been shown to equal
  one frame. An access unit starts at an AUD, a parameter set, or the first
  slice of a new picture.
- Each OBS connection is a relay client and gets the same late-join bootstrap
  as the viewfinder.

### Stall detection

- When webcam mode is on, the relay tracks the time of the last video byte.
- After 12 s with no video while the control session still answers, the state
  becomes **stalled**. The app shows: "The camera stopped sending video. Its
  screen may have gone to sleep. Tap the camera's screen to wake it."
- It then tries at most two STOP/START preview cycles, 30 s apart. 30 s of
  steady video resets that budget. After two failed cycles it stops retrying
  and keeps waiting, with the same message.
- The fork showed this stall is real (screen sleep, ~35 s, only a tap
  recovered it) but never proved STOP/START recovers it. The retries are
  cheap; the message is what users rely on.

### The gallery while webcam mode is on

This is my call. The commit that added preview start/stop on route change
(`6e44506`) records that the gallery only loaded again once the preview was
stopped. Its comment blames "the camera's single HTTP connection", but the
`START_LIVE_STREAM` video arrives on the control socket (TCP 6666), not HTTP.
So the conflict may come from the OSC MJPEG path or from load on the camera,
and nobody has measured which. Until the on-device check settles it, the
restriction applies to **HTTP media traffic only**:

- Allowed: the library listing (`GET_FILE_LIST`, on the control socket). That
  includes the refresh after a reconnect, so the library refills as it does
  today after a drop.
- Paused: thumbnails, opening media and downloads, which all use HTTP on port
  80. Thumbnails already cached keep showing.
- The gallery and downloads pages show a notice: "Webcam mode is on. The
  camera can't stream and transfer files at the same time. [Turn off webcam
  mode]".
- Turning webcam mode on while a download is running is blocked, with "Finish
  or cancel your downloads first." Nothing is cancelled for the user, and a
  multi-GB transfer never competes with the stream.
- The on-device check (Verification, step 5) decides whether this stays. If
  browsing and downloading don't break the stream, the restriction comes out
  in the same release.

### The OSC MJPEG viewfinder path

This is my call. The viewfinder still probes OSC MJPEG first, as it does
today, because some bodies may offer it. Webcam mode always uses the Rust
`START_LIVE_STREAM` stream, whatever the viewfinder uses. If the viewfinder is
on OSC while webcam mode is on, the two use different transports and don't
share anything. The Luna Ultra isn't known to offer OSC; the fork, on
firmware v1.1.15, used `START_LIVE_STREAM`. The viewfinder diagnostics already
record which path ran, so the owner's test confirms it.

### Status for the UI

A Tauri command returns a typed webcam status for the frontend:
`off | starting | streaming | stalled | stopped`, plus the URL, the current
codec and resolution parsed from the SPS, client count, and seconds since the
last frame. The frontend polls it every second while webcam mode is on. A
Tauri event would also work, and the builder may choose one.

## Manual

- A new docs page, "Use as a webcam (OBS)":
  - OBS install link, then the steps with screenshots.
  - The OBS Media Source settings that matter: Local File off, the Input URL,
    "Restart playback when source becomes active" off.
  - Camera settings: set **Screen Auto Sleep** and **Auto Power Off** to their
    longest values or Off, and keep the camera on power for long calls.
  - Limits: no audio, the preview's resolution only (around 720p), some
    delay, the resolution follows the camera mode, and thumbnails and
    downloads pause while webcam mode is on.
- README feature list: one line for webcam mode.
- `docs/FEATURES.md`: a webcam mode row with what was verified on the device.

## Verification

- Rust unit tests: framing split at every offset; NAL and access-unit
  splitting; GOP cache reset and cap; TS packet structure (sync bytes,
  continuity counters, PAT/PMT, PCR, PES headers).
- **Fixtures.** No real capture is in the repo yet. This is my call:
  - Unit tests start on synthetic HEVC made with ffmpeg/x265: an IDR GOP, a
    CRA GOP, with and without AUDs, multi-slice pictures, and a stream that
    switches 1280×720 → 720×1280 mid-way. Small files go in
    `src-tauri/tests/fixtures/`.
  - The owner captures real camera output with the existing
    `scripts/probe-liveview.mjs --seconds 20` (writes `probe-out/tcp-dump.bin`).
    Take one capture in Video mode and one that switches modes during the
    capture. Trimmed captures become fixtures, and the same tests must pass
    on them **before release**. Real data is what catches a wrong guess about
    AUDs, keyframe type or slice layout.
  - Resolution is always read from the SPS, never assumed. `docs/FEATURES.md`
    says 1280×960 while the fork measured 1280×720, and the capture settles it.
- A muxed test file built from each fixture must pass
  `ffprobe -show_streams` (codec hevc, the expected width and height) and
  `ffmpeg -f null -` without decode errors. Run this in CI if ffmpeg is
  available there; otherwise run it locally and record the output in the plan.
- On device:
  1. OBS on macOS plays the stream and its Virtual Camera shows up in a
     browser camera test.
  2. Join and rejoin OBS mid-stream; switch camera modes during a stream.
  3. A 30-minute run with screen sleep off.
  4. Let the screen sleep to confirm the stalled message.
  5. Check whether gallery browsing breaks the stream (decides whether the
     restriction above stays).
- The owner is testing on the latest firmware, so on-device checks are done
  by the owner. The build must work with no other changes.

## Left to the builder

- Rust module layout, for example `src-tauri/src/webcam/{mux.rs, nal.rs, server.rs}`.
- Whether status reaches the UI by polling or by events.
- Exact UI layout of the toggle and panel within the camera page, following
  the UI rules in CLAUDE.md.
- Muxer internals: PCR interval, PAT/PMT cadence within reason, PES packing.
