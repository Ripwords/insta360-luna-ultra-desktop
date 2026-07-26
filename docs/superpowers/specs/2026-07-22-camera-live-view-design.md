# Camera Live View — Design

Date: 2026-07-22
Status: approved, not yet implemented

## Goal

Show a live preview from the Insta360 Luna Ultra in the desktop app, using the
same TCP control protocol the mobile app uses.

## Verdict: feasible

The desktop app already speaks the protocol that carries live video. Three of
the four required pieces exist today.

| Piece                              | Where                   | Status                     |
| ---------------------------------- | ----------------------- | -------------------------- |
| UCD2 control session on TCP 6666   | `src-tauri/src/luna.rs` | exists                     |
| Command framing + Insta360 CRC     | `build_file_command`    | exists                     |
| Protobuf body encoding             | `wire_field_varint`     | exists                     |
| `START_LIVE_STREAM` command + body | —                       | derived, see below         |
| Video de-framing                   | `drain_frames`          | **discards stream frames** |
| Decode and paint                   | —                       | not built                  |

### Evidence

`PHONE_COMMAND_START_LIVE_STREAM = 1` and `STOP_LIVE_STREAM = 2`, per
[RigacciOrg/insta360-wifi-api](https://github.com/RigacciOrg/insta360-wifi-api),
which also ships the generated `insta360.messages.StartLiveStream` descriptor:

```
bool   enableVideo      = 2
uint32 videoBitrate     = 6
enum   resolution       = 7   (VideoResolution)
bool   enableGyro       = 8
uint32 videoBitrate1    = 9
enum   resolution1      = 10
uint32 previewStreamNum = 11
```

[NiklasVoigt/Insta360-Livestream](https://github.com/NiklasVoigt/Insta360-Livestream)
pulls a working livestream off port 6666 as an opaque hex blob. Decoding that
blob against the descriptor above yields command code `0x0001` and body
`100130283809400148285012` — that is `enableVideo:true, videoBitrate:40,
resolution:9 (RES_1440_720P30), enableGyro:true, videoBitrate1:40,
resolution1:18 (RES_480_240P30)`. Two independent sources agree, and the
resolution enum value matches that project's reported 1440x720 dual-fisheye
output.

`scripts/probe-liveview.mjs` builds the same body from our own encoder and
produces byte-identical output. The command we will send is the command the
mobile app sends.

## Unknowns, and how the design absorbs them

We are building without first capturing real camera traffic. Each unknown is
resolved at runtime rather than assumed.

1. **Is there a simpler OSC path?** The device-info parser already looks for an
   SSID containing `.OSC`, and Insta360 360 cameras expose an OSC HTTP API with
   an MJPEG `camera.getLivePreview`. On start, probe it first (1.5s budget). If
   JPEG markers appear, use it and skip everything below.
2. **How is video framed?** `drain_frames` hardcodes stream frames to 16 bytes,
   which is only correct for the keepalive hello. Read the length field instead
   and fall back to 16 when it reads as zero — that is exactly the hello's
   shape, so both cases work without knowing which carries video.
3. **H.264 or H.265?** Sniff the first Annex-B NAL. The two have distinguishable
   NAL headers, and the SPS carries profile and level, so the WebCodecs codec
   string is derived from the wire.

## Architecture

### Rust

`luna.rs` is already 713 lines; streaming goes in a new `src-tauri/src/liveview.rs`.

The change to `luna.rs` is deliberately small: `drain_frames` returns an enum,
`File(RawResponse) | Stream(Vec<u8>)`, and the reader task forwards `Stream`
payloads onto a `tokio::sync::broadcast`. With no subscriber, behaviour is
unchanged — the existing connect, keepalive, and delete paths are untouched.

`liveview.rs` owns the OSC probe, `START_LIVE_STREAM` / `STOP_LIVE_STREAM`, and
a tokio HTTP server on an ephemeral localhost port that serves the buffered
elementary stream as a chunked response.

Two commands:

- `luna_liveview_start() -> { url, transport: "mjpeg" | "annexb", codec, diagnostics }`
- `luna_liveview_stop()`

### Frontend

- `app/utils/annexB.ts` — pure and dependency-free: split the byte stream into
  access units, distinguish H.264 from H.265, derive the codec string from the
  SPS. Fully unit-testable without hardware, so it is written test-first.
- `app/composables/useLiveView.ts` — start/stop lifecycle, shaped like
  `useCamera.ts`.
- `app/components/LiveView.client.vue` — `<img>` when transport is `mjpeg`,
  otherwise `fetch` → `VideoDecoder` → canvas.

### Why a localhost stream rather than Tauri IPC

Video-rate traffic through IPC means per-message JSON overhead. Serving over
localhost HTTP lets the frontend consume a `ReadableStream` directly, and
avoids the `blob:` URL decoding limitation already hit in this app's WKWebView.
Decoding runs on the GPU via `VideoDecoder`, so no ffmpeg dependency is added
to the bundle.

## Diagnostics contract

Because the first real run is against hardware we have not captured, a failure
must be self-explaining. Every stage reports what it observed:

- which transport was selected, and why the other was rejected
- whether the camera accepted `START_LIVE_STREAM`, and any response body
- observed bytes/sec after the command
- frame-type histogram and the true frame sizes seen
- first NAL bytes and the derived codec string
- the exact `VideoDecoder.configure` argument, on config failure

A failed run must produce enough detail to fix the next attempt without a
second round of questions.

## Scope

**v1 renders a flat dual-fisheye frame** — the raw 1440x720 stream painted to a
canvas, two circular images side by side. This proves every stage independently;
routing through the 360 viewer would add a second failure surface that makes a
blank screen ambiguous.

Non-goals for v1: 360 reprojection via `PanoViewer`, PTZ control, recording
start/stop, audio, and camera setting configuration. Each is a plausible
follow-on unlocked by this work, and none can be built confidently until the
stream is known to flow.

## Testing

- Rust unit tests for the new frame parsing: a stream frame carrying a real
  length, and the 16-byte keepalive hello, both parsed correctly. Extends the
  existing `drain_frames` test.
- Vitest for `annexB.ts` against handcrafted H.264 and H.265 NAL fixtures.
- The existing mock-server integration test must still pass unchanged — proof
  that the `luna.rs` refactor did not disturb the shipping paths.
- End-to-end verification is manual, against the camera.

A mock-server stream replay was considered and deliberately dropped: the
hardware is available, and a real failure with the diagnostics above is more
informative than a synthetic success.

## Risks

- **The camera rejects `START_LIVE_STREAM`.** Most likely if Luna Ultra's
  firmware renumbered commands. Diagnostics surface the response body; the
  fallback is a traffic capture from the mobile app.
- **Video does not ride stream frames.** The frame-type histogram will show an
  unrecognised type, which tells us where to look.
- **WebCodecs rejects the derived codec string.** Isolated to `annexB.ts` and
  fixable without touching the transport.
- **Throughput.** ~1-2 MB/s over localhost HTTP is unremarkable, but the
  broadcast channel needs a bounded buffer with an explicit drop policy so a
  slow consumer cannot grow memory without limit.
