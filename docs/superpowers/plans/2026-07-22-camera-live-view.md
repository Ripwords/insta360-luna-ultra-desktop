# Camera Live View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a live preview from the Insta360 Luna Ultra in the desktop app, by asking the camera to start a preview stream over the control session that already exists and painting the decoded frames to a canvas.

**Architecture:** The Rust side stops discarding UCD2 STREAM frames and instead fans their payloads out over a broadcast channel, which a tiny hand-rolled localhost HTTP server re-serves as a raw elementary stream. The frontend fetches that stream, splits it into access units, derives the WebCodecs codec string from the SPS on the wire, and decodes to a canvas via `VideoDecoder`. A simpler OSC MJPEG transport is probed first and short-circuits everything else if the camera supports it.

**Tech Stack:** Rust / tokio / Tauri v2 commands, Nuxt 4 + Vue 3 composables, WebCodecs `VideoDecoder`, vitest for frontend units, `cargo test` for Rust units.

## Global Constraints

- **No new Cargo dependencies.** The localhost HTTP server and the OSC probe are hand-rolled, matching how this codebase already hand-rolls the UCD2 protocol. `tokio` features currently enabled are `net`, `time`, `sync`, `io-util`, `macros`, `rt` — do not add more.
- **No new npm dependencies.**
- **Never use `any` to fix a type error.** Use `as unknown as X` only when strictly necessary.
- **TDD.** Write the failing test first, watch it fail, then implement.
- **Conventional Commits** (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).
- **Existing behaviour must not regress.** The connect, keepalive, delete and media-listing paths in `src-tauri/src/luna.rs` must work exactly as before. The existing mock-server integration test `handshake_and_delete_against_mock_server` must pass untouched.
- **v1 renders a flat dual-fisheye frame.** No 360 reprojection, no PTZ, no recording controls, no audio.
- Camera default host is `192.168.42.1`. Control port is `6666`.
- Every failure path must surface diagnostics, not a blank screen. See Task 5.

## File Structure

| File                                          | Responsibility                                                                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/utils/annexB.ts` (create)                | Pure byte-level parsing: split NAL units, detect H.264 vs H.265, derive the WebCodecs codec string, group NALs into access units. No I/O, no Vue. |
| `tests/annexB.test.ts` (create)               | Unit tests for the above.                                                                                                                         |
| `src-tauri/src/luna.rs` (modify)              | Return STREAM payloads instead of dropping them; expose the session to `liveview.rs`.                                                             |
| `src-tauri/src/liveview.rs` (create)          | `START_LIVE_STREAM` / `STOP_LIVE_STREAM`, the localhost stream server, and diagnostics counters.                                                  |
| `src-tauri/src/lib.rs` (modify)               | Register the new module, state and commands.                                                                                                      |
| `app/utils/lunaClient.ts` (modify)            | Thin typed wrappers for the new Tauri commands.                                                                                                   |
| `app/composables/useLiveView.ts` (create)     | Start/stop lifecycle, transport selection, OSC probe, reactive state.                                                                             |
| `app/components/LiveView.client.vue` (create) | Canvas + `VideoDecoder`, or `<img>` for MJPEG. Renders the diagnostics panel.                                                                     |
| `app/pages/index.vue` (modify)                | Mount the live view once connected.                                                                                                               |

**Note on a deliberate spec deviation:** the design doc has `luna_liveview_start` return a `codec` field. It does not. The codec string is derived from the SPS in `annexB.ts`, frontend-side, because that is where the parsing lives — returning it from Rust would mean duplicating the SPS parser. The OSC probe likewise runs frontend-side, reusing `cameraFetch` (which already bypasses CORS via the Tauri HTTP plugin) instead of hand-rolling an HTTP client in Rust.

---

### Task 1: Annex-B parsing utilities

Pure functions, no hardware, no I/O. This is the piece most likely to need iteration after the first real run, so it is isolated and fully tested.

**Files:**

- Create: `app/utils/annexB.ts`
- Test: `tests/annexB.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `type NalCodec = "h264" | "h265"`
  - `interface AccessUnit { key: boolean; data: Uint8Array }`
  - `splitNalUnits(bytes: Uint8Array): Uint8Array[]`
  - `detectCodec(units: Uint8Array[]): NalCodec | null`
  - `nalType(unit: Uint8Array, codec: NalCodec): number`
  - `buildCodecString(units: Uint8Array[], codec: NalCodec): string | null`
  - `groupAccessUnits(units: Uint8Array[], codec: NalCodec): AccessUnit[]`

- [ ] **Step 1: Write the failing test**

Create `tests/annexB.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  buildCodecString,
  detectCodec,
  groupAccessUnits,
  nalType,
  splitNalUnits,
} from "~/utils/annexB";

/** Prefix each payload with a 4-byte Annex-B start code and concatenate. */
function annexB(...payloads: number[][]): Uint8Array {
  const out: number[] = [];
  for (const payload of payloads) out.push(0, 0, 0, 1, ...payload);
  return new Uint8Array(out);
}

/**
 * H.265 SPS laid out per ITU-T H.265 7.3.2.2:
 * 2-byte NAL header, then sps_video_parameter_set_id/max_sub_layers/nesting,
 * then profile_tier_level (profile byte, 4 compat bytes, 6 constraint bytes,
 * level byte). These values are the canonical Main profile / level 3.1.
 */
const H265_SPS = [
  0x42,
  0x01, // NAL header, type 33 (SPS)
  0x01, // vps_id 0, max_sub_layers_minus1 0, nesting 1
  0x01, // profile_space 0, tier 0, profile_idc 1 (Main)
  0x60,
  0x00,
  0x00,
  0x00, // general_profile_compatibility_flags
  0xb0,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00, // constraint flags
  0x5d, // general_level_idc 93 -> level 3.1
];
const H265_VPS = [0x40, 0x01, 0x0c];
const H265_IDR = [0x26, 0x01, 0x80]; // type 19 (IDR_W_RADL), first slice in pic
const H265_TRAIL = [0x02, 0x01, 0x80]; // type 1 (TRAIL_R), first slice in pic

/** H.264 SPS: header byte, then profile_idc, constraint flags, level_idc. */
const H264_SPS = [0x67, 0x64, 0x00, 0x28];
const H264_PPS = [0x68, 0xee];
const H264_IDR = [0x65, 0x88]; // type 5, first_mb_in_slice == 0
const H264_NONIDR = [0x41, 0x88]; // type 1, first_mb_in_slice == 0

describe("splitNalUnits", () => {
  it("splits on 4-byte and 3-byte start codes and drops them", () => {
    const stream = new Uint8Array([0, 0, 0, 1, 0xaa, 0xbb, 0, 0, 1, 0xcc]);
    expect(splitNalUnits(stream)).toEqual([new Uint8Array([0xaa, 0xbb]), new Uint8Array([0xcc])]);
  });

  it("ignores leading bytes before the first start code", () => {
    const stream = new Uint8Array([0x99, 0x99, 0, 0, 0, 1, 0xaa]);
    expect(splitNalUnits(stream)).toEqual([new Uint8Array([0xaa])]);
  });

  it("returns nothing for a stream with no start codes", () => {
    expect(splitNalUnits(new Uint8Array([1, 2, 3]))).toEqual([]);
  });
});

describe("detectCodec", () => {
  it("recognises H.265 by its VPS/SPS NAL types", () => {
    expect(detectCodec(splitNalUnits(annexB(H265_VPS, H265_SPS)))).toBe("h265");
  });

  it("recognises H.264 by its SPS/PPS NAL types", () => {
    expect(detectCodec(splitNalUnits(annexB(H264_SPS, H264_PPS)))).toBe("h264");
  });

  it("returns null when no parameter sets are present", () => {
    expect(detectCodec(splitNalUnits(annexB([0x02, 0x01, 0x80])))).toBeNull();
  });
});

describe("nalType", () => {
  it("reads the 6-bit type from the H.265 two-byte header", () => {
    expect(nalType(new Uint8Array(H265_SPS), "h265")).toBe(33);
  });

  it("reads the 5-bit type from the H.264 one-byte header", () => {
    expect(nalType(new Uint8Array(H264_SPS), "h264")).toBe(7);
  });
});

describe("buildCodecString", () => {
  it("derives the canonical Main profile string from an H.265 SPS", () => {
    const units = splitNalUnits(annexB(H265_VPS, H265_SPS));
    expect(buildCodecString(units, "h265")).toBe("hvc1.1.6.L93.B0");
  });

  it("derives avc1.PPCCLL from an H.264 SPS", () => {
    const units = splitNalUnits(annexB(H264_SPS, H264_PPS));
    expect(buildCodecString(units, "h264")).toBe("avc1.640028");
  });

  it("returns null when the SPS is absent", () => {
    expect(buildCodecString(splitNalUnits(annexB(H264_PPS)), "h264")).toBeNull();
  });

  it("returns null when the SPS is truncated", () => {
    const truncated = splitNalUnits(annexB([0x42, 0x01, 0x01]));
    expect(buildCodecString(truncated, "h265")).toBeNull();
  });

  it("strips emulation prevention bytes before parsing", () => {
    // 0x00 0x00 0x03 in the payload encodes a literal 0x00 0x00
    const spsWithEmulation = [
      0x42, 0x01, 0x01, 0x01, 0x60, 0x00, 0x00, 0x03, 0x00, 0xb0, 0x00, 0x00, 0x03, 0x00, 0x00,
      0x00, 0x5d,
    ];
    const units = splitNalUnits(annexB(spsWithEmulation));
    expect(buildCodecString(units, "h265")).toBe("hvc1.1.6.L93.B0");
  });
});

describe("groupAccessUnits", () => {
  it("bundles parameter sets with the following H.265 keyframe", () => {
    const units = splitNalUnits(annexB(H265_VPS, H265_SPS, H265_IDR));
    const access = groupAccessUnits(units, "h265");
    expect(access).toHaveLength(1);
    expect(access[0]!.key).toBe(true);
  });

  it("starts a new H.265 access unit at each first-slice VCL NAL", () => {
    const units = splitNalUnits(annexB(H265_IDR, H265_TRAIL, H265_TRAIL));
    const access = groupAccessUnits(units, "h265");
    expect(access.map((unit) => unit.key)).toEqual([true, false, false]);
  });

  it("marks H.264 IDR units as keyframes and others as delta", () => {
    const units = splitNalUnits(annexB(H264_SPS, H264_PPS, H264_IDR, H264_NONIDR));
    const access = groupAccessUnits(units, "h264");
    expect(access.map((unit) => unit.key)).toEqual([true, false]);
  });

  it("re-emits start codes so the decoder receives valid Annex-B", () => {
    const units = splitNalUnits(annexB(H264_SPS, H264_PPS, H264_IDR));
    const [first] = groupAccessUnits(units, "h264");
    expect(Array.from(first!.data.subarray(0, 5))).toEqual([0, 0, 0, 1, 0x67]);
  });

  it("returns nothing when no VCL NAL has arrived yet", () => {
    const units = splitNalUnits(annexB(H264_SPS, H264_PPS));
    expect(groupAccessUnits(units, "h264")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run vitest run tests/annexB.test.ts`
Expected: FAIL — `Failed to resolve import "~/utils/annexB"`.

- [ ] **Step 3: Write the implementation**

Create `app/utils/annexB.ts`:

```typescript
/**
 * Byte-level Annex-B helpers for the camera live view.
 *
 * The camera hands us a raw elementary stream with no container, so
 * everything WebCodecs needs — which codec, which profile and level, where
 * one frame ends and the next begins — has to be read off the wire. Keeping
 * this pure makes it testable without a camera attached.
 */

export type NalCodec = "h264" | "h265";

export interface AccessUnit {
  key: boolean;
  data: Uint8Array;
}

const START_CODE = new Uint8Array([0, 0, 0, 1]);

/** H.265 parameter sets: VPS, SPS, PPS. */
const H265_VPS = 32;
const H265_SPS = 33;
const H265_PPS = 34;
/** H.265 IRAP range (BLA_W_LP..CRA_NUT) — any of these starts a keyframe. */
const H265_IRAP_MIN = 16;
const H265_IRAP_MAX = 23;
/** H.265 NAL types below this are VCL (picture data). */
const H265_VCL_MAX = 31;

const H264_SPS = 7;
const H264_PPS = 8;
const H264_IDR = 5;
const H264_NON_IDR = 1;

/** Split a raw Annex-B stream into NAL payloads, start codes removed. */
export function splitNalUnits(bytes: Uint8Array): Uint8Array[] {
  const starts: Array<{ at: number; size: number }> = [];
  for (let i = 0; i + 2 < bytes.length; i++) {
    if (bytes[i] !== 0 || bytes[i + 1] !== 0) continue;
    if (bytes[i + 2] === 1) {
      starts.push({ at: i, size: 3 });
      i += 2;
    } else if (bytes[i + 2] === 0 && bytes[i + 3] === 1) {
      starts.push({ at: i, size: 4 });
      i += 3;
    }
  }

  const units: Uint8Array[] = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]!.at + starts[i]!.size;
    const to = starts[i + 1]?.at ?? bytes.length;
    if (to > from) units.push(bytes.subarray(from, to));
  }
  return units;
}

/**
 * Remove emulation prevention bytes: the encoder inserts 0x03 after any
 * 0x00 0x00 pair so the payload can never contain a start code.
 */
function unescapeRbsp(unit: Uint8Array): Uint8Array {
  const out = new Uint8Array(unit.length);
  let written = 0;
  let zeros = 0;
  for (const byte of unit) {
    if (zeros === 2 && byte === 0x03) {
      zeros = 0;
      continue;
    }
    out[written++] = byte;
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, written);
}

export function nalType(unit: Uint8Array, codec: NalCodec): number {
  if (unit.length === 0) return -1;
  return codec === "h265" ? (unit[0]! >> 1) & 0x3f : unit[0]! & 0x1f;
}

/**
 * Distinguish the two codecs by their parameter-set NAL types. H.265 is
 * checked first because its VPS byte (0x40) decodes to an invalid H.264
 * type, so the two cannot be confused.
 */
export function detectCodec(units: Uint8Array[]): NalCodec | null {
  for (const unit of units) {
    if (unit.length === 0 || (unit[0]! & 0x80) !== 0) continue;
    const h265 = (unit[0]! >> 1) & 0x3f;
    if (h265 === H265_VPS || h265 === H265_SPS || h265 === H265_PPS) return "h265";
    const h264 = unit[0]! & 0x1f;
    if (h264 === H264_SPS || h264 === H264_PPS) return "h264";
  }
  return null;
}

const findSps = (units: Uint8Array[], codec: NalCodec) =>
  units.find((unit) => nalType(unit, codec) === (codec === "h265" ? H265_SPS : H264_SPS));

const hex = (value: number) => value.toString(16).padStart(2, "0");

/** Reverse a 32-bit value bit-by-bit, as the HEVC codec string requires. */
function reverseBits32(value: number): number {
  let out = 0;
  for (let bit = 0; bit < 32; bit++) {
    out = ((out << 1) | ((value >>> bit) & 1)) >>> 0;
  }
  return out >>> 0;
}

/**
 * Build the codec string `VideoDecoder.configure` expects.
 *
 * H.264 is `avc1.PPCCLL` — profile_idc, constraint flags and level_idc
 * straight out of the SPS. H.265 is `hvc1.A.B.C.D` per ISO/IEC 14496-15,
 * which needs the profile_tier_level structure decoded.
 */
export function buildCodecString(units: Uint8Array[], codec: NalCodec): string | null {
  const raw = findSps(units, codec);
  if (!raw) return null;
  const sps = unescapeRbsp(raw);

  if (codec === "h264") {
    if (sps.length < 4) return null;
    return `avc1.${hex(sps[1]!)}${hex(sps[2]!)}${hex(sps[3]!)}`;
  }

  // 2-byte NAL header, 1 byte of ids/flags, then profile_tier_level:
  // profile byte, 4 compatibility bytes, 6 constraint bytes, level byte.
  if (sps.length < 15) return null;

  const profileByte = sps[3]!;
  const profileSpace = (profileByte >> 6) & 0x03;
  const tierFlag = (profileByte >> 5) & 0x01;
  const profileIdc = profileByte & 0x1f;

  const compatibility = ((sps[4]! << 24) | (sps[5]! << 16) | (sps[6]! << 8) | sps[7]!) >>> 0;

  const constraints: string[] = [];
  for (let i = 8; i < 14; i++) constraints.push(hex(sps[i]!));
  while (constraints.length > 0 && constraints.at(-1) === "00") constraints.pop();

  const space = profileSpace === 0 ? "" : String.fromCharCode(64 + profileSpace);
  const tier = tierFlag === 0 ? "L" : "H";

  const parts = [
    `hvc1.${space}${profileIdc}`,
    reverseBits32(compatibility).toString(16),
    `${tier}${sps[14]!}`,
    ...constraints,
  ];
  return parts.join(".");
}

const isVcl = (type: number, codec: NalCodec) =>
  codec === "h265" ? type <= H265_VCL_MAX : type === H264_IDR || type === H264_NON_IDR;

const isKeyNal = (type: number, codec: NalCodec) =>
  codec === "h265" ? type >= H265_IRAP_MIN && type <= H265_IRAP_MAX : type === H264_IDR;

/**
 * A new access unit begins at the first slice of a picture. H.265 signals
 * this with first_slice_segment_in_pic_flag, the top bit after the 2-byte
 * header; H.264 signals it with first_mb_in_slice == 0, which as ue(v)
 * means the top bit after the 1-byte header is set.
 */
function startsPicture(unit: Uint8Array, codec: NalCodec): boolean {
  const offset = codec === "h265" ? 2 : 1;
  if (unit.length <= offset) return false;
  return (unit[offset]! & 0x80) !== 0;
}

/**
 * Group NAL units into decodable access units, re-adding start codes.
 * Leading parameter sets are carried into the access unit that follows them,
 * which is what lets the decoder configure itself from the first keyframe.
 */
export function groupAccessUnits(units: Uint8Array[], codec: NalCodec): AccessUnit[] {
  const access: AccessUnit[] = [];
  let pending: Uint8Array[] = [];
  let key = false;
  let seenVcl = false;

  const flush = () => {
    if (!seenVcl || pending.length === 0) return;
    const size = pending.reduce((total, unit) => total + START_CODE.length + unit.length, 0);
    const data = new Uint8Array(size);
    let at = 0;
    for (const unit of pending) {
      data.set(START_CODE, at);
      at += START_CODE.length;
      data.set(unit, at);
      at += unit.length;
    }
    access.push({ key, data });
    pending = [];
    key = false;
    seenVcl = false;
  };

  for (const unit of units) {
    const type = nalType(unit, codec);
    if (isVcl(type, codec) && startsPicture(unit, codec) && seenVcl) flush();
    if (isVcl(type, codec)) {
      seenVcl = true;
      if (isKeyNal(type, codec)) key = true;
    }
    pending.push(unit);
  }
  flush();
  return access;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run vitest run tests/annexB.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Lint and typecheck**

Run: `bun run lint && bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add app/utils/annexB.ts tests/annexB.test.ts
git commit -m "feat: annex-b parsing utilities for live view"
```

---

### Task 2: Surface STREAM frame payloads in `luna.rs`

The camera's video rides frames this code currently throws away. `drain_frames` hardcodes STREAM frames to 16 bytes, which is only correct for the keepalive hello.

The fix is smaller than it looks. A FILE frame is `12 + declared_length + 4`. The keepalive hello is 16 bytes and declares length zero — which is _exactly_ `12 + 0 + 4`. So both frame types share one length formula, and the hello falls out as the degenerate case. No guessing required about which type carries video.

**Files:**

- Modify: `src-tauri/src/luna.rs` (the `drain_frames` function around line 150, the `Session` struct around line 246, and `open_session` around line 300)

**Interfaces:**

- Consumes: nothing.
- Produces, for Task 3:
  - `pub(crate) const CODE_START_LIVE_STREAM: u16 = 1;`
  - `pub(crate) const CODE_STOP_LIVE_STREAM: u16 = 2;`
  - `pub(crate) struct Session` with `pub(crate) async fn send_command(&self, code: u16, body: &[u8], timeout: Duration) -> Result<RawResponse, String>` and `pub(crate) fn subscribe_stream(&self) -> broadcast::Receiver<Vec<u8>>`
  - `impl LunaState { pub(crate) async fn session(&self) -> Option<Arc<Session>> }`
  - `pub(crate) fn wire_field_varint(field: u32, value: u32) -> Vec<u8>`

- [ ] **Step 1: Write the failing test**

Add to the `mod tests` block at the bottom of `src-tauri/src/luna.rs`:

```rust
    /// A STREAM frame carrying real video must be returned with its payload,
    /// while the 16-byte keepalive hello must still be recognised and skipped.
    #[test]
    fn drain_frames_returns_stream_payloads() {
        let payload = vec![0xAAu8; 40];
        let mut frame_payload = Vec::new();
        frame_payload.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        frame_payload.extend_from_slice(&payload);
        frame_payload.extend_from_slice(&[0u8; 4]); // trailer
        let mut buffer = build_ucd2(UCD2_STREAM, 1, &frame_payload);

        // The keepalive hello declares zero length and is exactly 16 bytes
        buffer.extend_from_slice(&build_stream_hello(2));

        let frames = drain_frames(&mut buffer);
        assert_eq!(frames.len(), 2, "expected the video frame and the hello");
        match &frames[0] {
            Frame::Stream(data) => assert_eq!(data, &payload),
            other => panic!("expected a stream payload, got {other:?}"),
        }
        match &frames[1] {
            Frame::Stream(data) => assert!(data.is_empty(), "hello carries no payload"),
            other => panic!("expected the hello, got {other:?}"),
        }
        assert!(buffer.is_empty(), "both frames should be consumed");
    }

    /// The existing FILE parsing must be untouched by the refactor.
    #[test]
    fn drain_frames_still_parses_file_responses() {
        let mut raw = Vec::new();
        raw.extend_from_slice(&12u16.to_le_bytes());
        raw.push(0x03);
        raw.extend_from_slice(&7u16.to_le_bytes());
        raw.extend_from_slice(&0x8000u32.to_le_bytes());
        raw.extend_from_slice(b"ok");
        let mut payload = Vec::new();
        payload.extend_from_slice(&(raw.len() as u32).to_le_bytes());
        payload.extend_from_slice(&raw);
        payload.extend_from_slice(&[0u8; 4]);
        let mut buffer = build_ucd2(UCD2_FILE, 9, &payload);

        let frames = drain_frames(&mut buffer);
        assert_eq!(frames.len(), 1);
        match &frames[0] {
            Frame::File(response) => {
                assert_eq!(response.code, 12);
                assert_eq!(response.request_id, 7);
                assert_eq!(response.body, b"ok");
            }
            other => panic!("expected a file response, got {other:?}"),
        }
    }
```

Then delete the now-superseded `drain_frames_parses_mock_response_shape` test, which asserts the old return type.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test --lib drain_frames`
Expected: FAIL — `cannot find type Frame in this scope`.

- [ ] **Step 3: Replace `drain_frames` and its return type**

In `src-tauri/src/luna.rs`, replace the whole `drain_frames` function and add the `Frame` enum immediately above it:

```rust
/// A parsed UCD2 frame. FILE frames answer commands; STREAM frames are the
/// keepalive hello (empty payload) or live video data.
#[derive(Debug, Clone)]
pub(crate) enum Frame {
    File(RawResponse),
    Stream(Vec<u8>),
}

/// Incremental UCD2 frame scanner over the receive buffer. Returns complete
/// frames and consumes processed bytes.
///
/// FILE and STREAM share one length formula: `12 + declared + 4`. The
/// keepalive hello declares zero and is 16 bytes, so it is simply the
/// degenerate case rather than a special case.
fn drain_frames(buffer: &mut Vec<u8>) -> Vec<Frame> {
    let mut frames = Vec::new();
    loop {
        let Some(start) = buffer.windows(4).position(|w| w == UCD2_MAGIC) else {
            buffer.clear();
            break;
        };
        if start > 0 {
            buffer.drain(..start);
        }
        if buffer.len() < 12 {
            break;
        }
        let frame_type = buffer[6];
        if frame_type != UCD2_FILE && frame_type != UCD2_STREAM {
            buffer.drain(..8);
            continue;
        }
        let declared = u32::from_le_bytes([buffer[8], buffer[9], buffer[10], buffer[11]]) as usize;
        // Guard against a corrupt length turning into an unbounded allocation
        if declared > 8 * 1024 * 1024 {
            buffer.drain(..8);
            continue;
        }
        let frame_len = 12 + declared + 4;
        if buffer.len() < frame_len {
            break;
        }
        let frame: Vec<u8> = buffer.drain(..frame_len).collect();

        if frame_type == UCD2_STREAM {
            frames.push(Frame::Stream(frame[12..12 + declared].to_vec()));
            continue;
        }
        if declared < 9 {
            continue;
        }
        let raw = &frame[12..12 + declared];
        frames.push(Frame::File(RawResponse {
            code: u16::from_le_bytes([raw[0], raw[1]]),
            request_id: u16::from_le_bytes([raw[3], raw[4]]),
            body: raw[9..].to_vec(),
        }));
    }
    frames
}
```

- [ ] **Step 4: Add the broadcast channel to `Session`**

Add this import near the other tokio imports at the top of the file:

```rust
use tokio::sync::broadcast;
```

Change the `Session` struct declaration from `struct Session {` to `pub(crate) struct Session {` and add one field after `info`:

```rust
    stream_tx: broadcast::Sender<Vec<u8>>,
```

Add these methods inside `impl Session`, and change `send_command` from `async fn` to `pub(crate) async fn`:

```rust
    /// Subscribe to live video payloads. Bounded: a slow consumer drops
    /// frames rather than growing memory without limit.
    pub(crate) fn subscribe_stream(&self) -> broadcast::Receiver<Vec<u8>> {
        self.stream_tx.subscribe()
    }
```

- [ ] **Step 5: Populate the channel in `open_session`**

In `open_session`, add the sender before the `Session` is constructed:

```rust
    let (stream_tx, _) = broadcast::channel::<Vec<u8>>(512);
```

Add `stream_tx: stream_tx.clone(),` to the `Session { .. }` initialiser.

Then update the reader task to route both frame kinds. Replace the body of the `Ok(n) => { .. }` arm with:

```rust
                Ok(n) => {
                    buffer.extend_from_slice(&chunk[..n]);
                    for frame in drain_frames(&mut buffer) {
                        match frame {
                            Frame::File(response) => {
                                if let Some(tx) = reader_pending.lock().unwrap().remove(&response.request_id) {
                                    let _ = tx.send(response);
                                }
                            }
                            // Empty payloads are keepalive echoes, not video
                            Frame::Stream(payload) if !payload.is_empty() => {
                                let _ = stream_tx.send(payload);
                            }
                            Frame::Stream(_) => {}
                        }
                    }
                }
```

Move the `let reader_pending = pending;` line so that `stream_tx` is also moved into the reader task.

- [ ] **Step 6: Expose what Task 3 needs**

Add near the other command-code constants at the top of the file:

```rust
pub(crate) const CODE_START_LIVE_STREAM: u16 = 1;
pub(crate) const CODE_STOP_LIVE_STREAM: u16 = 2;
```

Change `fn wire_field_varint` to `pub(crate) fn wire_field_varint`.

Add this impl block after the `LunaState` struct:

```rust
impl LunaState {
    /// The live control session, if one is open.
    pub(crate) async fn session(&self) -> Option<Arc<Session>> {
        self.session.lock().await.as_ref().cloned()
    }
}
```

- [ ] **Step 7: Run the full Rust test suite**

Run: `cd src-tauri && cargo test`
Expected: PASS. In particular `handshake_and_delete_against_mock_server` must still pass — that is the proof the refactor did not disturb the shipping paths.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/luna.rs
git commit -m "feat: surface UCD2 stream frame payloads

FILE and STREAM frames share one length formula, 12 + declared + 4; the
keepalive hello declares zero and is the degenerate case. Stream payloads
now fan out over a bounded broadcast channel instead of being discarded."
```

---

### Task 3: Live view transport in Rust

**Files:**

- Create: `src-tauri/src/liveview.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**

- Consumes from Task 2: `luna::Session::send_command`, `luna::Session::subscribe_stream`, `luna::LunaState::session`, `luna::wire_field_varint`, `luna::CODE_START_LIVE_STREAM`, `luna::CODE_STOP_LIVE_STREAM`.
- Produces, for Task 4, three Tauri commands:
  - `luna_liveview_start() -> LiveViewInfo { url: String, port: u16 }`
  - `luna_liveview_stop() -> ()`
  - `luna_liveview_stats() -> LiveViewStats { bytes: u64, frames: u64, first_bytes_hex: String, seconds: f64 }`

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/liveview.rs` containing only its test module for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// The body must match the capture from published reverse-engineering
    /// work byte for byte: enableVideo, videoBitrate 40, resolution 9
    /// (RES_1440_720P30), enableGyro, videoBitrate1 40, resolution1 18.
    #[test]
    fn start_live_stream_body_matches_known_capture() {
        let expected: Vec<u8> = vec![
            0x10, 0x01, 0x30, 0x28, 0x38, 0x09, 0x40, 0x01, 0x48, 0x28, 0x50, 0x12,
        ];
        assert_eq!(build_start_live_stream_body(), expected);
    }

    #[test]
    fn http_response_head_declares_a_streaming_body() {
        let head = String::from_utf8(response_head()).unwrap();
        assert!(head.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(head.contains("Content-Type: application/octet-stream"));
        assert!(head.contains("Access-Control-Allow-Origin: *"));
        assert!(head.ends_with("\r\n\r\n"));
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test --lib liveview`
Expected: FAIL — `cannot find function build_start_live_stream_body`. (If the module is not yet declared in `lib.rs`, the test will simply not run; add `mod liveview;` first — Step 4 covers the rest of the wiring.)

- [ ] **Step 3: Write the implementation**

Put this above the `mod tests` block in `src-tauri/src/liveview.rs`:

```rust
//! Live preview transport.
//!
//! Asks the camera to start a preview stream over the control session that
//! already exists, then re-serves the resulting elementary stream on an
//! ephemeral localhost port. The frontend consumes that with `fetch` and
//! decodes via WebCodecs, which keeps video-rate traffic off the Tauri IPC
//! bridge and avoids the `blob:` URL decoding limitation in WKWebView.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::luna::{
    wire_field_varint, LunaState, Session, CODE_START_LIVE_STREAM, CODE_STOP_LIVE_STREAM,
};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);

/// StartLiveStream, per `insta360.messages.StartLiveStream`:
///   2 enableVideo, 6 videoBitrate, 7 resolution, 8 enableGyro,
///   9 videoBitrate1, 10 resolution1
/// Resolution 9 is RES_1440_720P30 and 18 is RES_480_240P30, matching the
/// known-good capture. Values are deliberately identical to that capture so
/// that a failure here means the camera disagrees, not that we guessed.
fn build_start_live_stream_body() -> Vec<u8> {
    let mut body = wire_field_varint(2, 1);
    body.extend(wire_field_varint(6, 40));
    body.extend(wire_field_varint(7, 9));
    body.extend(wire_field_varint(8, 1));
    body.extend(wire_field_varint(9, 40));
    body.extend(wire_field_varint(10, 18));
    body
}

fn response_head() -> Vec<u8> {
    concat!(
        "HTTP/1.1 200 OK\r\n",
        "Content-Type: application/octet-stream\r\n",
        "Cache-Control: no-store\r\n",
        "Access-Control-Allow-Origin: *\r\n",
        "Connection: close\r\n\r\n"
    )
    .as_bytes()
    .to_vec()
}

/// Counters so a failed run explains itself instead of showing a blank canvas.
#[derive(Default)]
struct Stats {
    bytes: AtomicU64,
    frames: AtomicU64,
    first_bytes: StdMutex<Vec<u8>>,
    started: StdMutex<Option<Instant>>,
}

#[derive(Default)]
pub struct LiveViewState {
    inner: Mutex<Option<Running>>,
}

struct Running {
    port: u16,
    stats: Arc<Stats>,
    server: JoinHandle<()>,
    recorder: JoinHandle<()>,
}

impl Drop for Running {
    fn drop(&mut self) {
        self.server.abort();
        self.recorder.abort();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveViewInfo {
    pub url: String,
    pub port: u16,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LiveViewStats {
    pub bytes: u64,
    pub frames: u64,
    pub first_bytes_hex: String,
    pub seconds: f64,
}

/// Serve the elementary stream to whichever client connects. Each connection
/// gets its own subscription, so a page reload simply picks up the live edge.
async fn serve(listener: TcpListener, session: Arc<Session>) {
    loop {
        let Ok((mut socket, _)) = listener.accept().await else { break };
        let mut receiver = session.subscribe_stream();
        tokio::spawn(async move {
            // Read and discard the request line; we serve one thing.
            let mut scratch = [0u8; 1024];
            let _ = socket.read(&mut scratch).await;
            if socket.write_all(&response_head()).await.is_err() {
                return;
            }
            loop {
                match receiver.recv().await {
                    Ok(payload) => {
                        if socket.write_all(&payload).await.is_err() {
                            break;
                        }
                    }
                    // A slow client drops frames and keeps going
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => break,
                }
            }
        });
    }
}

#[tauri::command]
pub async fn luna_liveview_start(
    luna: State<'_, LunaState>,
    live: State<'_, LiveViewState>,
) -> Result<LiveViewInfo, String> {
    let session = luna
        .session()
        .await
        .ok_or_else(|| "camera is not connected".to_string())?;

    let mut guard = live.inner.lock().await;
    if let Some(running) = guard.as_ref() {
        return Ok(LiveViewInfo {
            url: format!("http://127.0.0.1:{}/stream", running.port),
            port: running.port,
        });
    }

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("cannot open the local stream port: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("cannot read the local stream port: {e}"))?
        .port();

    let stats = Arc::new(Stats::default());
    *stats.started.lock().unwrap() = Some(Instant::now());

    // Count independently of whether a client is attached, so "the camera
    // sent nothing" and "the browser never connected" stay distinguishable.
    let recorder_stats = Arc::clone(&stats);
    let mut recorder_rx = session.subscribe_stream();
    let recorder = tokio::spawn(async move {
        loop {
            match recorder_rx.recv().await {
                Ok(payload) => {
                    recorder_stats.bytes.fetch_add(payload.len() as u64, Ordering::Relaxed);
                    recorder_stats.frames.fetch_add(1, Ordering::Relaxed);
                    let mut first = recorder_stats.first_bytes.lock().unwrap();
                    if first.is_empty() {
                        *first = payload.iter().copied().take(64).collect();
                    }
                }
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => break,
            }
        }
    });

    let server = tokio::spawn(serve(listener, Arc::clone(&session)));

    session
        .send_command(CODE_START_LIVE_STREAM, &build_start_live_stream_body(), COMMAND_TIMEOUT)
        .await
        .map_err(|e| format!("camera rejected START_LIVE_STREAM: {e}"))?;

    *guard = Some(Running { port, stats, server, recorder });
    Ok(LiveViewInfo { url: format!("http://127.0.0.1:{port}/stream"), port })
}

#[tauri::command]
pub async fn luna_liveview_stop(
    luna: State<'_, LunaState>,
    live: State<'_, LiveViewState>,
) -> Result<(), String> {
    // Drop the server first so the socket closes even if the camera is gone
    live.inner.lock().await.take();
    if let Some(session) = luna.session().await {
        let _ = session.send_command(CODE_STOP_LIVE_STREAM, &[], COMMAND_TIMEOUT).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn luna_liveview_stats(live: State<'_, LiveViewState>) -> Result<LiveViewStats, String> {
    let guard = live.inner.lock().await;
    let Some(running) = guard.as_ref() else { return Ok(LiveViewStats::default()) };
    let first = running.stats.first_bytes.lock().unwrap().clone();
    let seconds = running
        .stats
        .started
        .lock()
        .unwrap()
        .map(|at| at.elapsed().as_secs_f64())
        .unwrap_or_default();
    Ok(LiveViewStats {
        bytes: running.stats.bytes.load(Ordering::Relaxed),
        frames: running.stats.frames.load(Ordering::Relaxed),
        first_bytes_hex: first.iter().map(|b| format!("{b:02x}")).collect(),
        seconds,
    })
}
```

- [ ] **Step 4: Wire it into `lib.rs`**

In `src-tauri/src/lib.rs`, add `mod liveview;` under `mod luna;`, add `.manage(liveview::LiveViewState::default())` after the existing `.manage(...)` line, and add three entries to `tauri::generate_handler!`:

```rust
      liveview::luna_liveview_start,
      liveview::luna_liveview_stop,
      liveview::luna_liveview_stats,
```

- [ ] **Step 5: Run the tests**

Run: `cd src-tauri && cargo test`
Expected: PASS, including the two new `liveview` tests and the untouched mock-server integration test.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/liveview.rs src-tauri/src/lib.rs
git commit -m "feat: live view transport over a localhost stream server"
```

---

### Task 4: Client wrappers and the live view composable

The OSC probe lives here rather than in Rust because `cameraFetch` already bypasses CORS through the Tauri HTTP plugin — reusing it avoids hand-rolling an HTTP client natively.

**Files:**

- Modify: `app/utils/lunaClient.ts`
- Create: `app/composables/useLiveView.ts`

**Interfaces:**

- Consumes from Task 3: `luna_liveview_start`, `luna_liveview_stop`, `luna_liveview_stats`.
- Consumes from Task 1: `detectCodec`, `buildCodecString`, `groupAccessUnits`, `splitNalUnits`.
- Produces, for Task 5: `useLiveView()` returning `{ active, transport, streamUrl, error, diagnostics, start, stop }` where `transport` is `Ref<"mjpeg" | "annexb" | null>` and `diagnostics` is `Ref<string[]>`.

- [ ] **Step 1: Add the client wrappers**

Append these to the `lunaClient` object in `app/utils/lunaClient.ts`, after `deleteFiles`:

```typescript
  async liveViewStart(): Promise<{ url: string; port: number }> {
    return tauriInvoke<{ url: string; port: number }>("luna_liveview_start");
  },

  async liveViewStop(): Promise<void> {
    if (isTauri()) await tauriInvoke("luna_liveview_stop");
  },

  async liveViewStats(): Promise<LiveViewStats> {
    return tauriInvoke<LiveViewStats>("luna_liveview_stats");
  },

  /**
   * Some Insta360 bodies expose an OSC MJPEG preview on port 80. If this
   * camera does, it is a far simpler transport than the elementary stream,
   * so it is tried first. Returns the URL on success, null otherwise.
   */
  async probeOscPreview(host: string): Promise<string | null> {
    const url = baseUrl(host, "/osc/commands/execute");
    try {
      const response = await cameraFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json;charset=utf-8" },
        body: JSON.stringify({ name: "camera.getLivePreview" }),
      });
      if (!response.ok) return null;
      const type = response.headers.get("content-type") ?? "";
      return type.includes("multipart") || type.includes("jpeg") ? url : null;
    } catch {
      return null;
    }
  },
```

Add the type import at the top of the file, extending the existing import:

```typescript
import type { CameraInfo, LiveViewStats, MediaItem, MediaStorage } from "~/types/media";
```

And add to `app/types/media.ts`:

```typescript
export interface LiveViewStats {
  bytes: number;
  frames: number;
  firstBytesHex: string;
  seconds: number;
}
```

- [ ] **Step 2: Write the composable**

Create `app/composables/useLiveView.ts`:

```typescript
import type { LiveViewStats } from "~/types/media";
import { lunaClient } from "~/utils/lunaClient";

export type LiveTransport = "mjpeg" | "annexb";

/** How long to wait for any video byte before calling the attempt failed. */
const FIRST_BYTE_TIMEOUT_MS = 6000;

export function useLiveView() {
  const { host, isConnected } = useCamera();

  const active = useState<boolean>("liveview-active", () => false);
  const starting = useState<boolean>("liveview-starting", () => false);
  const transport = useState<LiveTransport | null>("liveview-transport", () => null);
  const streamUrl = useState<string | null>("liveview-url", () => null);
  const error = useState<string | null>("liveview-error", () => null);
  const diagnostics = useState<string[]>("liveview-diagnostics", () => []);

  const note = (line: string) => {
    diagnostics.value = [...diagnostics.value, line];
  };

  async function start() {
    if (starting.value || active.value) return;
    if (!isConnected.value) {
      error.value = "Connect to the camera first.";
      return;
    }
    starting.value = true;
    error.value = null;
    diagnostics.value = [];

    try {
      const osc = await lunaClient.probeOscPreview(host.value);
      if (osc) {
        note("OSC MJPEG preview available; using it.");
        transport.value = "mjpeg";
        streamUrl.value = osc;
        active.value = true;
        return;
      }
      note("No OSC MJPEG preview; falling back to the control-session stream.");

      const info = await lunaClient.liveViewStart();
      note(`Camera accepted START_LIVE_STREAM. Serving on port ${info.port}.`);
      transport.value = "annexb";
      streamUrl.value = info.url;
      active.value = true;

      // If nothing arrives, say so rather than showing an empty canvas
      setTimeout(async () => {
        if (!active.value || transport.value !== "annexb") return;
        const stats = await lunaClient.liveViewStats().catch(() => null);
        if (stats && stats.bytes === 0) {
          error.value = "The camera accepted the command but sent no video.";
          note("0 bytes received. The stream may use a frame type we do not yet recognise.");
        }
      }, FIRST_BYTE_TIMEOUT_MS);
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
      note(`Failed: ${error.value}`);
      await stop();
    } finally {
      starting.value = false;
    }
  }

  async function stop() {
    active.value = false;
    transport.value = null;
    streamUrl.value = null;
    await lunaClient.liveViewStop().catch(() => {});
  }

  async function refreshStats(): Promise<LiveViewStats | null> {
    if (!active.value) return null;
    return lunaClient.liveViewStats().catch(() => null);
  }

  return {
    active,
    starting,
    transport,
    streamUrl,
    error,
    diagnostics,
    note,
    start,
    stop,
    refreshStats,
  };
}
```

- [ ] **Step 3: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/utils/lunaClient.ts app/types/media.ts app/composables/useLiveView.ts
git commit -m "feat: live view client wrappers and composable"
```

---

### Task 5: The live view component and page wiring

**Files:**

- Create: `app/components/LiveView.client.vue`
- Modify: `app/pages/index.vue`

**Interfaces:**

- Consumes from Task 4: `useLiveView()`.
- Consumes from Task 1: `splitNalUnits`, `detectCodec`, `buildCodecString`, `groupAccessUnits`.

- [ ] **Step 1: Write the component**

Create `app/components/LiveView.client.vue`:

```vue
<script setup lang="ts">
import { buildCodecString, detectCodec, groupAccessUnits, splitNalUnits } from "~/utils/annexB";
import type { NalCodec } from "~/utils/annexB";

const { active, starting, transport, streamUrl, error, diagnostics, note, start, stop } =
  useLiveView();

const canvas = ref<HTMLCanvasElement | null>(null);
let decoder: VideoDecoder | null = null;
let abort: AbortController | null = null;

/** Bytes that arrived mid-NAL and must be prepended to the next chunk. */
let carry = new Uint8Array(0);
let codec: NalCodec | null = null;
let configured = false;
let timestamp = 0;

function paint(frame: VideoFrame) {
  const element = canvas.value;
  if (!element) {
    frame.close();
    return;
  }
  if (element.width !== frame.displayWidth) element.width = frame.displayWidth;
  if (element.height !== frame.displayHeight) element.height = frame.displayHeight;
  element.getContext("2d")?.drawImage(frame, 0, 0);
  frame.close();
}

async function consumeAnnexB(url: string) {
  abort = new AbortController();
  const response = await fetch(url, { signal: abort.signal });
  const reader = response.body?.getReader();
  if (!reader) throw new Error("the local stream returned no body");

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;

    const merged = new Uint8Array(carry.length + value.length);
    merged.set(carry);
    merged.set(value, carry.length);

    const units = splitNalUnits(merged);
    if (units.length === 0) {
      carry = merged;
      continue;
    }
    // The last unit may be incomplete; hold it back for the next chunk.
    const complete = units.slice(0, -1);
    const tail = units.at(-1)!;
    carry = new Uint8Array(4 + tail.length);
    carry.set([0, 0, 0, 1]);
    carry.set(tail, 4);
    if (complete.length === 0) continue;

    codec ??= detectCodec(complete);
    if (!codec) continue;

    if (!configured) {
      const codecString = buildCodecString(complete, codec);
      if (!codecString) continue;
      note(`Detected ${codec}, codec string ${codecString}.`);
      decoder = new VideoDecoder({
        output: paint,
        error: (cause) => {
          error.value = `Decoder error: ${cause.message}`;
          note(error.value);
        },
      });
      try {
        decoder.configure({ codec: codecString, optimizeForLatency: true });
      } catch (cause) {
        error.value = `VideoDecoder rejected "${codecString}": ${
          cause instanceof Error ? cause.message : String(cause)
        }`;
        note(error.value);
        return;
      }
      configured = true;
    }

    for (const unit of groupAccessUnits(complete, codec)) {
      // Wait for a keyframe before feeding the decoder anything
      if (!unit.key && timestamp === 0) continue;
      decoder?.decode(
        new EncodedVideoChunk({
          type: unit.key ? "key" : "delta",
          timestamp: timestamp,
          data: unit.data,
        }),
      );
      timestamp += 33333; // ~30fps in microseconds
    }
  }
}

function reset() {
  abort?.abort();
  abort = null;
  try {
    decoder?.close();
  } catch {
    // Already closed; nothing to do
  }
  decoder = null;
  carry = new Uint8Array(0);
  codec = null;
  configured = false;
  timestamp = 0;
}

watch([active, transport, streamUrl], async ([on, kind, url]) => {
  if (!on || kind !== "annexb" || !url) {
    reset();
    return;
  }
  try {
    await consumeAnnexB(url);
  } catch (cause) {
    if ((cause as Error)?.name === "AbortError") return;
    error.value = cause instanceof Error ? cause.message : String(cause);
    note(`Stream read failed: ${error.value}`);
  }
});

onBeforeUnmount(() => {
  reset();
  void stop();
});
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center gap-3">
      <UButton
        :label="active ? 'Stop live view' : 'Start live view'"
        :loading="starting"
        :icon="active ? 'i-lucide-square' : 'i-lucide-video'"
        color="primary"
        @click="active ? stop() : start()"
      />
      <span v-if="transport" class="text-sm text-muted"> transport: {{ transport }} </span>
    </div>

    <UAlert
      v-if="error"
      icon="i-lucide-triangle-alert"
      color="warning"
      variant="subtle"
      :title="error"
    />

    <div class="overflow-hidden rounded-lg bg-elevated">
      <img v-if="active && transport === 'mjpeg' && streamUrl" :src="streamUrl" class="w-full" />
      <canvas v-show="active && transport === 'annexb'" ref="canvas" class="w-full" />
      <p v-if="!active" class="p-8 text-center text-sm text-muted">Live view is stopped.</p>
    </div>

    <details v-if="diagnostics.length > 0" class="text-sm">
      <summary class="cursor-pointer text-muted">Diagnostics</summary>
      <pre class="mt-2 overflow-x-auto rounded bg-elevated p-3 text-xs">{{
        diagnostics.join("\n")
      }}</pre>
    </details>
  </div>
</template>
```

- [ ] **Step 2: Mount it on the connect page**

In `app/pages/index.vue`, inside the `<template #body>` grid, add this as the first child of the `lg:order-1` column, immediately after the opening `<div class="order-2 flex flex-col ...">` tag:

```vue
<LiveView v-if="isConnected" />
```

- [ ] **Step 3: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: no errors. If `VideoDecoder`, `VideoFrame` or `EncodedVideoChunk` are unknown types, add `"dom"` and `"dom.iterable"` to `compilerOptions.lib` in `tsconfig.json` rather than casting to `any`.

- [ ] **Step 4: Run the full test suite**

Run: `bun run vitest run && cd src-tauri && cargo test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add app/components/LiveView.client.vue app/pages/index.vue
git commit -m "feat: live view component on the connect page"
```

- [ ] **Step 6: Manual verification against the camera**

This is the only step that needs hardware, and it is expected to need iteration.

1. Join the camera's Wi-Fi.
2. `bun run dev`
3. Connect on the Connect page, then press **Start live view**.
4. Expand **Diagnostics** and record what it says.

Possible outcomes and what each means:

| Observation                              | Meaning                            | Next move                                                                 |
| ---------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------- |
| Video appears                            | Done.                              | Consider 360 reprojection as a follow-on.                                 |
| "OSC MJPEG preview available" then video | The easy path existed.             | The Annex-B path stays as fallback.                                       |
| "camera rejected START_LIVE_STREAM"      | Luna Ultra renumbered the command. | Capture the mobile app's traffic; the correct code goes in `liveview.rs`. |
| Accepted, but 0 bytes                    | Video does not ride STREAM frames. | Run `node scripts/probe-liveview.mjs` and read the frame-type histogram.  |
| Bytes arrive, decoder errors             | Codec string is wrong.             | The diagnostics print the exact string and codec; fix `annexB.ts`.        |

Do not mark this step complete until video renders or the failure is recorded with its diagnostics.

---

## Self-Review

**Spec coverage:**

| Spec requirement                            | Task                                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| OSC probe first, 1.5s budget                | Task 4, `probeOscPreview` (no explicit timer; the Tauri HTTP plugin's default applies and a failure falls through) |
| `START_LIVE_STREAM` over existing session   | Task 3                                                                                                             |
| Read length field, fall back to 16 on zero  | Task 2 — unified as `12 + declared + 4`, which yields 16 for the hello                                             |
| H.264 vs H.265 sniffing from SPS            | Task 1                                                                                                             |
| `luna.rs` untouched shipping paths          | Task 2, Step 7 asserts the mock-server test still passes                                                           |
| New `liveview.rs` module                    | Task 3                                                                                                             |
| `annexB.ts` written test-first              | Task 1                                                                                                             |
| `useLiveView.ts` shaped like `useCamera.ts` | Task 4                                                                                                             |
| `LiveView.client.vue` with img/canvas split | Task 5                                                                                                             |
| Localhost stream rather than IPC            | Task 3                                                                                                             |
| Diagnostics contract                        | Tasks 4 and 5; every table row in Task 5 Step 6 maps to a diagnostic line                                          |
| Bounded buffer with drop policy             | Task 2 (`broadcast::channel(512)`), Task 3 (`RecvError::Lagged` → continue)                                        |
| Rust tests for frame parsing                | Task 2                                                                                                             |
| Vitest for `annexB.ts`                      | Task 1                                                                                                             |
| Flat dual-fisheye v1                        | Task 5 — canvas painted directly, no reprojection                                                                  |
| No new dependencies                         | Hand-rolled server in Task 3; OSC probe reuses `cameraFetch`                                                       |

Two deliberate deviations from the spec, both noted in the File Structure section: `luna_liveview_start` does not return `codec`, and the OSC probe runs frontend-side. Both avoid duplicating logic.

**Placeholder scan:** no TBDs, no "add error handling", no "similar to Task N". Every code step contains complete code.

**Type consistency:** `LiveViewStats` is declared once in `app/types/media.ts` (Task 4) and matches the Rust `LiveViewStats` serialised as camelCase (Task 3). `NalCodec`, `AccessUnit`, `splitNalUnits`, `detectCodec`, `nalType`, `buildCodecString` and `groupAccessUnits` are defined in Task 1 and used with identical names in Task 5. `Frame`, `Session::send_command`, `Session::subscribe_stream`, `LunaState::session` and `wire_field_varint` are exposed in Task 2 and consumed under those exact names in Task 3.
