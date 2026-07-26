# Camera Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A professional camera settings page that reads and writes the Luna Ultra's exposure, colour, zoom, format and stabilisation settings over the existing control session.

**Architecture:** Rust gains one allowlisted passthrough command that sends a raw protobuf body and returns the raw response. All protobuf encoding, decoding and schema knowledge lives in TypeScript, reusing the decoder proven by `scripts/probe-settings.mjs`. This keeps the wire semantics in the layer that vitest can test and avoids a second protobuf implementation in Rust.

**Tech Stack:** Rust / Tauri v2 command, TypeScript wire-format codec, Nuxt 4 + Nuxt UI, vitest.

## Global Constraints

- **No new Cargo or npm dependencies.** The codec is hand-rolled, matching how this codebase already hand-rolls UCD2 framing.
- **Never use `any`.** Use `as unknown as X` only when strictly necessary.
- **TDD.** Failing test first, watch it fail, then implement.
- **Conventional Commits.**
- Existing behaviour must not regress: `cargo test` (11 tests) and `vitest` (108 tests) must stay green, including `handshake_and_delete_against_mock_server`.
- Command codes are allowlisted in Rust. `DELETE_FILES` (12) is **deliberately excluded** — it already has its own batching command.
- Findings that this plan depends on are recorded in
  `docs/superpowers/specs/2026-07-22-camera-settings-probe-findings.md`.
- **proto3 omits default values.** A field absent from a response means "zero/first enum value", not "unsupported". Never infer support from absence.

## Scope

In: the codec, reading all settings, writing exposure/colour/zoom/format/stabilisation settings, and the settings UI.

Out (each its own follow-up): capture start/stop and shutter, gimbal control, subject tracking. Capture writes to storage and interacts with mode state, so it deserves its own verification pass rather than riding along here.

## File Structure

| File                                                | Responsibility                                            |
| --------------------------------------------------- | --------------------------------------------------------- |
| `app/utils/protobuf.ts` (create)                    | Pure protobuf wire format. No schema, no I/O.             |
| `tests/protobuf.test.ts` (create)                   | Round-trip and real-capture tests for the above.          |
| `app/assets/luna-protocol-schema.json` (create)     | Trimmed schema: 41 messages, 71 enums, ~53 KB.            |
| `scripts/build-schema.mjs` (create)                 | Regenerates the trimmed asset from the full probe schema. |
| `app/utils/lunaProto.ts` (create)                   | Schema-driven encode/decode by message name.              |
| `tests/lunaProto.test.ts` (create)                  | Decodes real bytes captured from the camera.              |
| `src-tauri/src/luna.rs` (modify)                    | `luna_command` passthrough with an allowlist.             |
| `src-tauri/src/lib.rs` (modify)                     | Register the command.                                     |
| `app/utils/lunaSettings.ts` (create)                | Typed get/set for options and photography options.        |
| `app/composables/useCameraSettings.ts` (create)     | Reactive settings state, load and save.                   |
| `app/components/CameraSettings.client.vue` (create) | The settings UI.                                          |
| `app/pages/camera.vue` (create)                     | Hosts live view beside the settings panel.                |

---

### Task 1: Protobuf wire-format codec

Pure functions, no schema, no I/O.

**Files:**

- Create: `app/utils/protobuf.ts`
- Test: `tests/protobuf.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `interface RawField { field: number; wire: number; value: number | Uint8Array }`
  - `decodeRaw(bytes: Uint8Array): RawField[]`
  - `encodeVarint(value: number): number[]`
  - `encodeTag(field: number, wire: number): number[]`
  - `encodeLengthDelimited(field: number, payload: Uint8Array): number[]`
  - `zigzagEncode(value: number): number`, `zigzagDecode(value: number): number`
  - `concatBytes(parts: number[][]): Uint8Array`

- [ ] **Step 1: Write the failing test**

Create `tests/protobuf.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  concatBytes,
  decodeRaw,
  encodeLengthDelimited,
  encodeTag,
  encodeVarint,
  zigzagDecode,
  zigzagEncode,
} from "~/utils/protobuf";

const hex = (s: string) => new Uint8Array(s.match(/../g)!.map((b) => parseInt(b, 16)));

describe("encodeVarint", () => {
  it("encodes single-byte values", () => {
    expect(encodeVarint(0)).toEqual([0]);
    expect(encodeVarint(1)).toEqual([1]);
    expect(encodeVarint(127)).toEqual([127]);
  });

  it("encodes multi-byte values little-endian base 128", () => {
    expect(encodeVarint(128)).toEqual([0x80, 0x01]);
    expect(encodeVarint(300)).toEqual([0xac, 0x02]);
  });

  it("survives values beyond 32 bits", () => {
    // Timestamps like activate_time are milliseconds since epoch
    const bytes = encodeVarint(1781336808139);
    const [record] = decodeRaw(new Uint8Array([...encodeTag(1, 0), ...bytes]));
    expect(record!.value).toBe(1781336808139);
  });
});

describe("zigzag", () => {
  it("round-trips signed values", () => {
    for (const value of [0, -1, 1, -2, 2, 2147483647, -2147483648]) {
      expect(zigzagDecode(zigzagEncode(value))).toBe(value);
    }
  });
});

describe("decodeRaw", () => {
  it("reads varint fields", () => {
    // field 2 varint 1, field 6 varint 40 — from the live-stream body
    const records = decodeRaw(hex("10013028"));
    expect(records.map((r) => [r.field, r.value])).toEqual([
      [2, 1],
      [6, 40],
    ]);
  });

  it("reads length-delimited fields", () => {
    const records = decodeRaw(hex("1203e80501"));
    expect(records).toHaveLength(1);
    expect(records[0]!.field).toBe(2);
    expect(records[0]!.wire).toBe(2);
    expect(Array.from(records[0]!.value as Uint8Array)).toEqual([0xe8, 0x05, 0x01]);
  });

  it("reads 64-bit and 32-bit fields", () => {
    const sixtyFour = decodeRaw(new Uint8Array([...encodeTag(1, 1), 1, 2, 3, 4, 5, 6, 7, 8]));
    expect((sixtyFour[0]!.value as Uint8Array).length).toBe(8);
    const thirtyTwo = decodeRaw(new Uint8Array([...encodeTag(1, 5), 1, 2, 3, 4]));
    expect((thirtyTwo[0]!.value as Uint8Array).length).toBe(4);
  });

  it("stops cleanly on a truncated field rather than throwing", () => {
    expect(() => decodeRaw(hex("1205e805"))).not.toThrow();
    expect(decodeRaw(hex("1205e805"))).toEqual([]);
  });

  it("returns nothing for empty input", () => {
    expect(decodeRaw(new Uint8Array(0))).toEqual([]);
  });
});

describe("encodeLengthDelimited", () => {
  it("prefixes the payload with its length", () => {
    const bytes = encodeLengthDelimited(2, hex("e80501"));
    expect(Array.from(concatBytes([bytes]))).toEqual([0x12, 0x03, 0xe8, 0x05, 0x01]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run vitest run tests/protobuf.test.ts`
Expected: FAIL — `Failed to resolve import "~/utils/protobuf"`.

- [ ] **Step 3: Implement**

Create `app/utils/protobuf.ts`:

```typescript
/**
 * Protobuf wire format, the minimum this app needs.
 *
 * Deliberately schema-free: this layer only knows tags, wire types and
 * lengths. Message semantics live in lunaProto.ts. Keeping them apart means
 * the risky part — byte handling — is testable against real captures without
 * dragging a 53 KB schema into every test.
 */

export interface RawField {
  field: number;
  wire: number;
  /** varint payloads decode to a number; the rest stay as bytes. */
  value: number | Uint8Array;
}

export const WIRE_VARINT = 0;
export const WIRE_64BIT = 1;
export const WIRE_BYTES = 2;
export const WIRE_32BIT = 5;

/**
 * Multiplication rather than bit shifts: values like activate_time exceed
 * 32 bits, and JS bitwise operators silently truncate there.
 */
export function encodeVarint(value: number): number[] {
  const out: number[] = [];
  let rest = Math.max(0, Math.floor(value));
  while (rest > 0x7f) {
    out.push((rest % 128) | 0x80);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return out;
}

export const encodeTag = (field: number, wire: number): number[] => encodeVarint(field * 8 + wire);

export function encodeLengthDelimited(field: number, payload: Uint8Array): number[] {
  return [...encodeTag(field, WIRE_BYTES), ...encodeVarint(payload.length), ...payload];
}

export const zigzagEncode = (value: number): number => (value < 0 ? -value * 2 - 1 : value * 2);
export const zigzagDecode = (value: number): number =>
  value % 2 === 0 ? value / 2 : -(value + 1) / 2;

export function concatBytes(parts: number[][]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function readVarint(bytes: Uint8Array, at: number): { value: number; at: number } | null {
  let value = 0;
  let scale = 1;
  let cursor = at;
  for (;;) {
    if (cursor >= bytes.length) return null;
    const byte = bytes[cursor++]!;
    value += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) return { value, at: cursor };
    scale *= 128;
    // A varint never exceeds 10 bytes; anything longer is corrupt
    if (scale > 2 ** 70) return null;
  }
}

/**
 * Decode one message into raw records. A truncated tail is dropped rather
 * than throwing — responses can be cut short, and a partial read should
 * degrade instead of taking down the UI.
 */
export function decodeRaw(bytes: Uint8Array): RawField[] {
  const out: RawField[] = [];
  let at = 0;
  while (at < bytes.length) {
    const tag = readVarint(bytes, at);
    if (!tag) break;
    at = tag.at;
    const field = Math.floor(tag.value / 8);
    const wire = tag.value % 8;
    if (field === 0) break;

    if (wire === WIRE_VARINT) {
      const value = readVarint(bytes, at);
      if (!value) break;
      at = value.at;
      out.push({ field, wire, value: value.value });
    } else if (wire === WIRE_BYTES) {
      const length = readVarint(bytes, at);
      if (!length || length.at + length.value > bytes.length) break;
      out.push({ field, wire, value: bytes.subarray(length.at, length.at + length.value) });
      at = length.at + length.value;
    } else if (wire === WIRE_64BIT || wire === WIRE_32BIT) {
      const width = wire === WIRE_64BIT ? 8 : 4;
      if (at + width > bytes.length) break;
      out.push({ field, wire, value: bytes.subarray(at, at + width) });
      at += width;
    } else {
      break; // groups are not used by this protocol
    }
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun run vitest run tests/protobuf.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/utils/protobuf.ts tests/protobuf.test.ts
git commit -m "feat: protobuf wire-format codec"
```

---

### Task 2: Schema asset and schema-driven message codec

**Files:**

- Create: `scripts/build-schema.mjs`
- Create: `app/assets/luna-protocol-schema.json` (generated)
- Create: `app/utils/lunaProto.ts`
- Test: `tests/lunaProto.test.ts`

**Interfaces:**

- Consumes Task 1: `decodeRaw`, `encodeVarint`, `encodeTag`, `encodeLengthDelimited`, `concatBytes`, `zigzagEncode`, `zigzagDecode`, `RawField`.
- Produces:
  - `type ProtoValue = string | number | boolean | ProtoObject | ProtoValue[]`
  - `interface ProtoObject { [key: string]: ProtoValue | undefined }`
  - `encodeMessage(messageName: string, value: ProtoObject): Uint8Array`
  - `decodeMessage(messageName: string, bytes: Uint8Array): ProtoObject`
  - `enumValue(enumName: string, name: string): number | null`
  - `enumNames(enumName: string): string[]`
  - `MSG` — string constants for the message names used elsewhere.

- [ ] **Step 1: Write the schema build script**

Create `scripts/build-schema.mjs`:

```javascript
#!/usr/bin/env node
// Trims scripts/luna-protocol-schema.json (the full extraction, 114 KB) down
// to what the app actually needs, and writes it into app/assets.
//
//   node scripts/build-schema.mjs

import fs from "node:fs";
import path from "node:path";

const ROOTS = [
  "insta360.messages.Options",
  "insta360.messages.PhotographyOptions",
  "insta360.messages.GetOptions",
  "insta360.messages.GetOptionsResp",
  "insta360.messages.SetOptions",
  "insta360.messages.SetOptionsResp",
  "insta360.messages.GetPhotographyOptions",
  "insta360.messages.GetPhotographyOptionsResp",
  "insta360.messages.SetPhotographyOptions",
  "insta360.messages.SetPhotographyOptionsResp",
  "insta360.messages.GetCurrentCaptureStatusResp",
  "insta360.messages.CameraCaptureStatus",
];

/** Enums reachable only through option-type lists, not through a field. */
const EXTRA_ENUMS = [
  "insta360.messages.OptionType",
  "insta360.messages.PhotographyOptionType",
  "insta360.messages.FunctionMode",
];

const full = JSON.parse(fs.readFileSync("scripts/luna-protocol-schema.json", "utf8"));

const messages = new Set();
const enums = new Set(EXTRA_ENUMS);

function walk(name) {
  if (messages.has(name) || !full.messages[name]) return;
  messages.add(name);
  for (const field of Object.values(full.messages[name])) {
    if (!field.ref) continue;
    if (full.messages[field.ref]) walk(field.ref);
    else if (full.enums[field.ref]) enums.add(field.ref);
  }
}
for (const root of ROOTS) walk(root);

const missing = ROOTS.filter((root) => !full.messages[root]);
if (missing.length > 0) {
  console.error("missing roots:", missing);
  process.exit(1);
}

const trimmed = {
  messages: Object.fromEntries([...messages].sort().map((n) => [n, full.messages[n]])),
  enums: Object.fromEntries(
    [...enums]
      .sort()
      .filter((n) => full.enums[n])
      .map((n) => [n, full.enums[n]]),
  ),
};

const out = path.join("app", "assets", "luna-protocol-schema.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(trimmed));
console.log(
  `wrote ${out}: ${messages.size} messages, ${enums.size} enums, ` +
    `${fs.statSync(out).size} bytes`,
);
```

- [ ] **Step 2: Generate the asset**

Run: `node scripts/build-schema.mjs`
Expected: `wrote app/assets/luna-protocol-schema.json: 41 messages, 71 enums, ~53000 bytes`

- [ ] **Step 3: Write the failing test**

Create `tests/lunaProto.test.ts`. The hex strings are **real responses captured from the camera** by `scripts/probe-settings.mjs`:

```typescript
import { describe, expect, it } from "vitest";
import { MSG, decodeMessage, encodeMessage, enumNames, enumValue } from "~/utils/lunaProto";

const hex = (s: string) => new Uint8Array(s.match(/../g)!.map((b) => parseInt(b, 16)));

describe("decodeMessage", () => {
  it("decodes a real CAMERA_POSTURE response", () => {
    // 085d 1203 e80501 — option_types=93, value{ camera_posture=1 }
    const decoded = decodeMessage(MSG.GetOptionsResp, hex("085d1203e80501"));
    expect(decoded.option_types).toEqual(["CAMERA_POSTURE"]);
    expect((decoded.value as Record<string, unknown>).camera_posture).toBe(
      "CAMERA_POSTURE_ROTATE_90",
    );
  });

  it("decodes a real WINDOW_CROP_INFO response with a nested message", () => {
    const decoded = decodeMessage(
      MSG.GetOptionsResp,
      hex("087c120fe2070c080010001800200028003000"),
    );
    const crop = (decoded.value as Record<string, Record<string, unknown>>).window_crop_info;
    expect(crop).toEqual({
      src_width: 0,
      src_height: 0,
      dst_width: 0,
      dst_height: 0,
      crop_offset_x: 0,
      crop_offset_y: 0,
    });
  });

  it("decodes a real empty PTZ_CTRL response without inventing fields", () => {
    // The camera answered with an empty value and no option_types echo
    const decoded = decodeMessage(MSG.GetOptionsResp, hex("1200"));
    expect(decoded.option_types).toBeUndefined();
    expect(decoded.value).toEqual({});
  });

  it("keeps fields the schema does not know under $unknown", () => {
    // field 200 varint 7 cannot be in any schema we ship
    const decoded = decodeMessage(MSG.GetOptionsResp, hex("c00c07"));
    expect(decoded.$unknown).toEqual([{ field: 200, wire: 0, value: "7" }]);
  });

  it("reports an out-of-range enum as its number, not a crash", () => {
    // photo_sub_mode (field 40) = 8, which postdates the schema's PhotoSubMode
    const decoded = decodeMessage(MSG.Options, hex("c00208"));
    expect(decoded.photo_sub_mode).toBe(8);
  });
});

describe("encodeMessage", () => {
  it("encodes a GetPhotographyOptions request the camera accepted", () => {
    // Unpacked repeated enums, matching the captured request shape
    const bytes = encodeMessage(MSG.GetPhotographyOptions, {
      option_types: ["EXPOSURE_MODE", "WHITE_BALANCE"],
      function_mode: "FUNCTION_MODE_NORMAL_VIDEO",
    });
    const decoded = decodeMessage(MSG.GetPhotographyOptions, bytes);
    expect(decoded.option_types).toEqual(["EXPOSURE_MODE", "WHITE_BALANCE"]);
    expect(decoded.function_mode).toBe("FUNCTION_MODE_NORMAL_VIDEO");
  });

  it("round-trips a nested settings write", () => {
    const bytes = encodeMessage(MSG.SetPhotographyOptions, {
      option_types: ["WHITE_BALANCE_VALUE", "EXPOSURE_BIAS"],
      value: { white_balance_value: 5600, exposure_bias: 0 },
      function_mode: "FUNCTION_MODE_NORMAL_VIDEO",
    });
    const decoded = decodeMessage(MSG.SetPhotographyOptions, bytes);
    expect(decoded.option_types).toEqual(["WHITE_BALANCE_VALUE", "EXPOSURE_BIAS"]);
    expect((decoded.value as Record<string, unknown>).white_balance_value).toBe(5600);
  });

  it("round-trips a double, which zoom and focal length use", () => {
    const bytes = encodeMessage(MSG.PhotographyOptions, { focal_length_value: 17.4 });
    expect(decodeMessage(MSG.PhotographyOptions, bytes).focal_length_value as number).toBeCloseTo(
      17.4,
      6,
    );
  });

  it("omits proto3 default values, as the camera does", () => {
    expect(encodeMessage(MSG.PhotographyOptions, { exposure_bias: 0 }).length).toBe(0);
  });

  it("throws on an unknown field name rather than silently dropping it", () => {
    expect(() => encodeMessage(MSG.PhotographyOptions, { not_a_field: 1 })).toThrow(/not_a_field/);
  });

  it("throws on an unknown enum name", () => {
    expect(() => encodeMessage(MSG.PhotographyOptions, { white_balance: "WB_9999K" })).toThrow(
      /WB_9999K/,
    );
  });
});

describe("enum helpers", () => {
  it("maps names to numbers", () => {
    expect(enumValue("insta360.messages.PhotographyOptions.WhiteBalance", "WB_5000K")).toBe(3);
  });

  it("lists names for building UI pickers", () => {
    const names = enumNames("insta360.messages.PhotographyOptions.WhiteBalance");
    expect(names).toContain("WB_AUTO");
    expect(names).toContain("WB_6500K");
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `bun run vitest run tests/lunaProto.test.ts`
Expected: FAIL — cannot resolve `~/utils/lunaProto`.

- [ ] **Step 5: Implement**

Create `app/utils/lunaProto.ts`:

```typescript
import schemaJson from "~/assets/luna-protocol-schema.json";
import {
  concatBytes,
  decodeRaw,
  encodeLengthDelimited,
  encodeTag,
  encodeVarint,
  WIRE_32BIT,
  WIRE_64BIT,
  WIRE_BYTES,
  WIRE_VARINT,
  zigzagDecode,
  zigzagEncode,
} from "~/utils/protobuf";

interface FieldSpec {
  name: string;
  type: string;
  repeated: boolean;
  ref?: string;
}
interface Schema {
  messages: Record<string, Record<string, FieldSpec>>;
  enums: Record<string, Record<string, string>>;
}

const schema = schemaJson as unknown as Schema;

export type ProtoValue = string | number | boolean | ProtoObject | ProtoValue[];
export interface ProtoObject {
  [key: string]: ProtoValue | undefined;
}

/** Message names used across the app, so typos fail at build rather than run time. */
export const MSG = {
  Options: "insta360.messages.Options",
  PhotographyOptions: "insta360.messages.PhotographyOptions",
  GetOptions: "insta360.messages.GetOptions",
  GetOptionsResp: "insta360.messages.GetOptionsResp",
  SetOptions: "insta360.messages.SetOptions",
  SetOptionsResp: "insta360.messages.SetOptionsResp",
  GetPhotographyOptions: "insta360.messages.GetPhotographyOptions",
  GetPhotographyOptionsResp: "insta360.messages.GetPhotographyOptionsResp",
  SetPhotographyOptions: "insta360.messages.SetPhotographyOptions",
  SetPhotographyOptionsResp: "insta360.messages.SetPhotographyOptionsResp",
  CameraCaptureStatus: "insta360.messages.CameraCaptureStatus",
} as const;

export const OPTION_TYPE = "insta360.messages.OptionType";
export const PHOTOGRAPHY_OPTION_TYPE = "insta360.messages.PhotographyOptionType";
export const FUNCTION_MODE = "insta360.messages.FunctionMode";

const VARINT_TYPES = new Set(["int32", "int64", "uint32", "uint64", "bool", "enum"]);
const ZIGZAG_TYPES = new Set(["sint32", "sint64"]);

export function enumValue(enumName: string, name: string): number | null {
  const values = schema.enums[enumName];
  if (!values) return null;
  for (const [number, candidate] of Object.entries(values)) {
    if (candidate === name) return Number(number);
  }
  return null;
}

export function enumNames(enumName: string): string[] {
  const values = schema.enums[enumName];
  if (!values) return [];
  return Object.entries(values)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([, name]) => name);
}

export const enumName = (ref: string | undefined, value: number): string | number =>
  (ref ? schema.enums[ref]?.[String(value)] : undefined) ?? value;

const fieldsOf = (messageName: string): Record<string, FieldSpec> => {
  const fields = schema.messages[messageName];
  if (!fields) throw new Error(`unknown message ${messageName}`);
  return fields;
};

function toNumber(spec: FieldSpec, value: ProtoValue): number {
  if (spec.type === "bool") return value ? 1 : 0;
  if (spec.type === "enum") {
    if (typeof value === "number") return value;
    const resolved = enumValue(spec.ref ?? "", String(value));
    if (resolved === null) throw new Error(`unknown enum value ${String(value)} for ${spec.name}`);
    return resolved;
  }
  return Number(value);
}

/** proto3 omits defaults on the wire; mirroring that keeps writes minimal. */
const isDefault = (spec: FieldSpec, value: ProtoValue): boolean =>
  spec.type === "bool" ? value === false : spec.type === "string" ? value === "" : value === 0;

function encodeField(number: number, spec: FieldSpec, value: ProtoValue): number[] {
  if (spec.type === "message") {
    const nested = encodeMessage(spec.ref ?? "", value as ProtoObject);
    return encodeLengthDelimited(number, nested);
  }
  if (spec.type === "string") {
    return encodeLengthDelimited(number, new TextEncoder().encode(String(value)));
  }
  if (spec.type === "double") {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, Number(value), true);
    return [...encodeTag(number, WIRE_64BIT), ...bytes];
  }
  if (spec.type === "float") {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setFloat32(0, Number(value), true);
    return [...encodeTag(number, WIRE_32BIT), ...bytes];
  }
  if (ZIGZAG_TYPES.has(spec.type)) {
    return [...encodeTag(number, WIRE_VARINT), ...encodeVarint(zigzagEncode(Number(value)))];
  }
  if (VARINT_TYPES.has(spec.type)) {
    return [...encodeTag(number, WIRE_VARINT), ...encodeVarint(toNumber(spec, value))];
  }
  throw new Error(`cannot encode ${spec.name}: unsupported type ${spec.type}`);
}

export function encodeMessage(messageName: string, value: ProtoObject): Uint8Array {
  const fields = fieldsOf(messageName);
  const byName = new Map(
    Object.entries(fields).map(([number, spec]) => [spec.name, { number, spec }]),
  );
  const parts: number[][] = [];

  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined || raw === null) continue;
    const entry = byName.get(key);
    if (!entry) throw new Error(`unknown field ${key} on ${messageName}`);
    const number = Number(entry.number);

    // Repeated scalars go out unpacked: that is the shape the camera's own
    // requests use, and packed encoding was never observed from it.
    const items = entry.spec.repeated && Array.isArray(raw) ? raw : [raw];
    for (const item of items) {
      if (!entry.spec.repeated && isDefault(entry.spec, item)) continue;
      parts.push(encodeField(number, entry.spec, item));
    }
  }
  return concatBytes(parts);
}

function decodeField(spec: FieldSpec, wire: number, value: number | Uint8Array): ProtoValue {
  if (spec.type === "message" && value instanceof Uint8Array) {
    return decodeMessage(spec.ref ?? "", value);
  }
  if (spec.type === "string" && value instanceof Uint8Array) {
    return new TextDecoder().decode(value);
  }
  if (spec.type === "bytes" && value instanceof Uint8Array) {
    return Array.from(value)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  if (spec.type === "double" && value instanceof Uint8Array && value.length === 8) {
    return new DataView(value.buffer, value.byteOffset, 8).getFloat64(0, true);
  }
  if (spec.type === "float" && value instanceof Uint8Array && value.length === 4) {
    return new DataView(value.buffer, value.byteOffset, 4).getFloat32(0, true);
  }
  if (typeof value === "number") {
    if (spec.type === "bool") return value === 1;
    if (spec.type === "enum") return enumName(spec.ref, value);
    if (ZIGZAG_TYPES.has(spec.type)) return zigzagDecode(value);
    return value;
  }
  // Wire type disagreed with the schema; hand back hex rather than guess
  return Array.from(value)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Decode by message name. Unknown fields are preserved under `$unknown` —
 * this camera is newer than the schema, so what it sends that we cannot name
 * is exactly what we want to see rather than discard.
 */
export function decodeMessage(messageName: string, bytes: Uint8Array): ProtoObject {
  const fields = fieldsOf(messageName);
  const out: ProtoObject = {};
  const unknown: Array<{ field: number; wire: number; value: string }> = [];

  for (const record of decodeRaw(bytes)) {
    const spec = fields[String(record.field)];
    if (!spec) {
      unknown.push({
        field: record.field,
        wire: record.wire,
        value:
          record.value instanceof Uint8Array
            ? Array.from(record.value)
                .map((b) => b.toString(16).padStart(2, "0"))
                .join("")
            : String(record.value),
      });
      continue;
    }
    const decoded = decodeField(spec, record.wire, record.value);
    if (spec.repeated) {
      const list = (out[spec.name] as ProtoValue[] | undefined) ?? [];
      list.push(decoded);
      out[spec.name] = list;
    } else {
      out[spec.name] = decoded;
    }
  }
  if (unknown.length > 0) out.$unknown = unknown as unknown as ProtoValue;
  return out;
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `bun run vitest run tests/lunaProto.test.ts`
Expected: PASS.

If the `$unknown` test fails because field 200 happens to exist in `GetOptionsResp`, pick a field number above 1000 instead and update the hex accordingly.

- [ ] **Step 7: Commit**

```bash
node scripts/build-schema.mjs
git add scripts/build-schema.mjs app/assets/luna-protocol-schema.json app/utils/lunaProto.ts tests/lunaProto.test.ts
git commit -m "feat: schema-driven protobuf message codec"
```

---

### Task 3: Rust command passthrough

**Files:**

- Modify: `src-tauri/src/luna.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**

- Consumes Task 2's callers: nothing at compile time.
- Produces: Tauri command `luna_command(code: u16, body: Vec<u8>) -> Vec<u8>`.

- [ ] **Step 1: Write the failing test**

Add to the `mod tests` block in `src-tauri/src/luna.rs`:

```rust
    /// The allowlist is the safety boundary between the webview and the
    /// camera. Destructive codes must not be reachable through it.
    #[test]
    fn command_allowlist_covers_settings_but_not_deletion() {
        for code in [
            CODE_TAKE_PICTURE,
            CODE_START_CAPTURE,
            CODE_STOP_CAPTURE,
            CODE_SET_OPTIONS,
            CODE_GET_OPTIONS,
            CODE_SET_PHOTOGRAPHY_OPTIONS,
            CODE_GET_PHOTOGRAPHY_OPTIONS,
            CODE_GET_CURRENT_CAPTURE_STATUS,
        ] {
            assert!(is_allowed_command(code), "code {code} should be allowed");
        }
        assert!(!is_allowed_command(CODE_DELETE_FILES), "deletion has its own command");
        assert!(!is_allowed_command(9999), "unknown codes must be refused");
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test --lib command_allowlist`
Expected: FAIL — `cannot find function is_allowed_command`.

- [ ] **Step 3: Implement**

Add the missing command-code constants next to the existing ones in `src-tauri/src/luna.rs`:

```rust
const CODE_TAKE_PICTURE: u16 = 3;
const CODE_START_CAPTURE: u16 = 4;
const CODE_STOP_CAPTURE: u16 = 5;
const CODE_SET_OPTIONS: u16 = 7;
const CODE_SET_PHOTOGRAPHY_OPTIONS: u16 = 9;
const CODE_GET_PHOTOGRAPHY_OPTIONS: u16 = 10;
```

Add the allowlist and the command, after `luna_delete_files`:

```rust
/// Commands the UI may send as raw protobuf. Deliberately excludes
/// DELETE_FILES, which keeps its own batching command, and anything not
/// listed here — the webview should not be able to reach arbitrary firmware
/// commands just because the transport can carry them.
fn is_allowed_command(code: u16) -> bool {
    matches!(
        code,
        CODE_TAKE_PICTURE
            | CODE_START_CAPTURE
            | CODE_STOP_CAPTURE
            | CODE_SET_OPTIONS
            | CODE_GET_OPTIONS
            | CODE_SET_PHOTOGRAPHY_OPTIONS
            | CODE_GET_PHOTOGRAPHY_OPTIONS
            | CODE_GET_CURRENT_CAPTURE_STATUS
    )
}

/// Send a protobuf body to the camera and return the raw response body.
/// Encoding and decoding live in the frontend, which owns the schema.
#[tauri::command]
pub async fn luna_command(state: State<'_, LunaState>, code: u16, body: Vec<u8>) -> Result<Vec<u8>, String> {
    if !is_allowed_command(code) {
        return Err(format!("command {code} is not permitted"));
    }
    let session = state
        .session()
        .await
        .ok_or_else(|| "camera is not connected".to_string())?;
    let response = session.send_command(code, &body, Duration::from_secs(10)).await?;
    Ok(response.body)
}
```

- [ ] **Step 4: Register it**

In `src-tauri/src/lib.rs`, add to `tauri::generate_handler!`:

```rust
      luna::luna_command,
```

- [ ] **Step 5: Run the full Rust suite**

Run: `cd src-tauri && cargo test`
Expected: PASS, 12 tests, including `handshake_and_delete_against_mock_server`.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/luna.rs src-tauri/src/lib.rs
git commit -m "feat: allowlisted protobuf command passthrough"
```

---

### Task 4: Settings client and composable

**Files:**

- Create: `app/utils/lunaSettings.ts`
- Create: `app/composables/useCameraSettings.ts`
- Modify: `app/utils/lunaClient.ts`

**Interfaces:**

- Consumes Task 2: `MSG`, `encodeMessage`, `decodeMessage`, `enumNames`, `PHOTOGRAPHY_OPTION_TYPE`, `OPTION_TYPE`, `FUNCTION_MODE`, `ProtoObject`.
- Consumes Task 3: `luna_command`.
- Produces:
  - `readPhotographyOptions(mode: string): Promise<ProtoObject>`
  - `writePhotographyOptions(mode: string, patch: ProtoObject): Promise<string[]>`
  - `readDeviceOptions(): Promise<ProtoObject>`
  - `useCameraSettings()` returning `{ settings, device, loading, saving, error, mode, load, update }`

- [ ] **Step 1: Add the client wrapper**

Append to the `lunaClient` object in `app/utils/lunaClient.ts`:

```typescript
  /** Send a raw protobuf body; returns the raw response body. */
  async command(code: number, body: Uint8Array): Promise<Uint8Array> {
    const response = await tauriInvoke<number[]>("luna_command", {
      code,
      body: Array.from(body),
    });
    return new Uint8Array(response);
  },
```

- [ ] **Step 2: Write the settings client**

Create `app/utils/lunaSettings.ts`:

```typescript
import {
  FUNCTION_MODE,
  MSG,
  OPTION_TYPE,
  PHOTOGRAPHY_OPTION_TYPE,
  decodeMessage,
  encodeMessage,
  enumNames,
  type ProtoObject,
} from "~/utils/lunaProto";
import { lunaClient } from "~/utils/lunaClient";

const CODE_SET_OPTIONS = 7;
const CODE_GET_OPTIONS = 8;
const CODE_SET_PHOTOGRAPHY_OPTIONS = 9;
const CODE_GET_PHOTOGRAPHY_OPTIONS = 10;

/**
 * Asking for every option type in one request risks a single unsupported
 * value spoiling the whole reply, which is exactly what the probe was built
 * to avoid. Batch, and merge what comes back.
 */
const BATCH = 12;

const chunk = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, i * size + size),
  );

async function readBatched(
  code: number,
  requestMessage: string,
  responseMessage: string,
  optionTypeEnum: string,
  extra: ProtoObject,
): Promise<ProtoObject> {
  const merged: ProtoObject = {};
  const supported: string[] = [];

  for (const batch of chunk(
    enumNames(optionTypeEnum).filter((n) => !n.endsWith("_NUM")),
    BATCH,
  )) {
    let response: Uint8Array;
    try {
      response = await lunaClient.command(
        code,
        encodeMessage(requestMessage, { option_types: batch, ...extra }),
      );
    } catch {
      continue; // one bad batch must not lose the rest
    }
    if (response.length === 0) continue;
    const decoded = decodeMessage(responseMessage, response);
    for (const name of (decoded.option_types as string[] | undefined) ?? []) supported.push(name);
    Object.assign(merged, (decoded.value as ProtoObject | undefined) ?? {});
  }
  merged.$supported = supported as unknown as ProtoObject[keyof ProtoObject];
  return merged;
}

export const readPhotographyOptions = (mode: string): Promise<ProtoObject> =>
  readBatched(
    CODE_GET_PHOTOGRAPHY_OPTIONS,
    MSG.GetPhotographyOptions,
    MSG.GetPhotographyOptionsResp,
    PHOTOGRAPHY_OPTION_TYPE,
    { function_mode: mode },
  );

export const readDeviceOptions = (): Promise<ProtoObject> =>
  readBatched(CODE_GET_OPTIONS, MSG.GetOptions, MSG.GetOptionsResp, OPTION_TYPE, {});

/**
 * Write a patch. The camera answers with the option types it accepted, which
 * is the only trustworthy confirmation — a silent success is not one.
 */
export async function writePhotographyOptions(
  mode: string,
  optionTypes: string[],
  patch: ProtoObject,
): Promise<string[]> {
  const response = await lunaClient.command(
    CODE_SET_PHOTOGRAPHY_OPTIONS,
    encodeMessage(MSG.SetPhotographyOptions, {
      option_types: optionTypes,
      value: patch,
      function_mode: mode,
    }),
  );
  if (response.length === 0) return [];
  const decoded = decodeMessage(MSG.SetPhotographyOptionsResp, response);
  return ((decoded.success_types as string[] | undefined) ?? []).map(String);
}

export async function writeDeviceOptions(
  optionTypes: string[],
  patch: ProtoObject,
): Promise<string[]> {
  const response = await lunaClient.command(
    CODE_SET_OPTIONS,
    encodeMessage(MSG.SetOptions, { option_types: optionTypes, value: patch }),
  );
  if (response.length === 0) return [];
  const decoded = decodeMessage(MSG.SetOptionsResp, response);
  return ((decoded.option_types as string[] | undefined) ?? []).map(String);
}

export { FUNCTION_MODE };
```

- [ ] **Step 3: Write the composable**

Create `app/composables/useCameraSettings.ts`:

```typescript
import type { ProtoObject } from "~/utils/lunaProto";
import {
  readDeviceOptions,
  readPhotographyOptions,
  writePhotographyOptions,
} from "~/utils/lunaSettings";

export function useCameraSettings() {
  const { isConnected } = useCamera();

  const settings = useState<ProtoObject>("camera-settings", () => ({}));
  const device = useState<ProtoObject>("camera-device-options", () => ({}));
  const mode = useState<string>("camera-settings-mode", () => "FUNCTION_MODE_NORMAL_VIDEO");
  const loading = useState<boolean>("camera-settings-loading", () => false);
  const saving = useState<string | null>("camera-settings-saving", () => null);
  const error = useState<string | null>("camera-settings-error", () => null);

  async function load() {
    if (!isConnected.value || loading.value) return;
    loading.value = true;
    error.value = null;
    try {
      const [photography, options] = await Promise.all([
        readPhotographyOptions(mode.value),
        readDeviceOptions(),
      ]);
      settings.value = photography;
      device.value = options;
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      loading.value = false;
    }
  }

  /**
   * Optimistically apply, then reconcile against what the camera confirms.
   * A setting the camera silently ignores must snap back rather than lie.
   */
  async function update(optionType: string, field: string, value: ProtoObject[string]) {
    const previous = settings.value[field];
    settings.value = { ...settings.value, [field]: value };
    saving.value = field;
    error.value = null;
    try {
      const accepted = await writePhotographyOptions(mode.value, [optionType], { [field]: value });
      if (!accepted.includes(optionType)) {
        settings.value = { ...settings.value, [field]: previous };
        error.value = `The camera did not accept ${field}.`;
      }
    } catch (cause) {
      settings.value = { ...settings.value, [field]: previous };
      error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      saving.value = null;
    }
  }

  watch(mode, () => void load());
  watch(isConnected, (connected) => {
    if (connected) void load();
  });

  return { settings, device, mode, loading, saving, error, load, update };
}
```

- [ ] **Step 4: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add app/utils/lunaSettings.ts app/composables/useCameraSettings.ts app/utils/lunaClient.ts
git commit -m "feat: camera settings client and composable"
```

---

### Task 5: Settings UI

**Files:**

- Create: `app/components/CameraSettings.client.vue`
- Create: `app/pages/camera.vue`

**Interfaces:**

- Consumes Task 4: `useCameraSettings()`.
- Consumes Task 2: `enumNames`.

- [ ] **Step 1: Write the component**

Create `app/components/CameraSettings.client.vue`:

```vue
<script setup lang="ts">
import { enumNames } from "~/utils/lunaProto";

const { settings, device, mode, loading, saving, error, load, update } = useCameraSettings();

const WB = "insta360.messages.PhotographyOptions.WhiteBalance";
const EXPOSURE = "insta360.messages.PhotographyOptions.ExposureMode";
const GAMMA = "insta360.messages.GammaMode";
const COLOR = "insta360.messages.PhotographyOptions.COLOR_MODE";
const FOV = "insta360.messages.PhotographyOptions.Fov_Type";
const FLICKER = "insta360.messages.Flicker";

/** Each control names the option type the camera expects for that field. */
const pickers = [
  { label: "Exposure mode", field: "exposure_mode", option: "EXPOSURE_MODE", values: EXPOSURE },
  { label: "White balance", field: "white_balance", option: "WHITE_BALANCE", values: WB },
  { label: "Colour mode", field: "color_mode", option: "COLOR_MODE", values: COLOR },
  { label: "Gamma", field: "gamma_mode", option: "VIDEO_GAMMA_MODE", values: GAMMA },
  { label: "Field of view", field: "fov_type", option: "FOV_TYPE", values: FOV },
  { label: "Flicker", field: "flicker", option: "FLICKER", values: FLICKER },
];

const sliders = [
  { label: "EV bias", field: "exposure_bias", option: "EXPOSURE_BIAS", min: -4, max: 4, step: 1 },
  { label: "Zoom", field: "zoom_scale", option: "ZOOM_SCALE", min: 1, max: 12, step: 1 },
  { label: "Sharpness", field: "sharpness", option: "SHARPNESS", min: 0, max: 4, step: 1 },
  {
    label: "ISO ceiling",
    field: "video_iso_top_limit",
    option: "VIDEO_ISO_TOP_LIMIT",
    min: 0,
    max: 6400,
    step: 100,
  },
];

const options = (name: string) => enumNames(name).map((value) => ({ label: value, value }));

const supported = computed(
  () => new Set((settings.value.$supported as string[] | undefined) ?? []),
);
const isSupported = (option: string) => supported.value.size === 0 || supported.value.has(option);

const battery = computed(() => {
  const status = device.value.battery_status as Record<string, unknown> | undefined;
  return typeof status?.battery_level === "number" ? status.battery_level : null;
});
const storage = computed(() => {
  const state = device.value.storage_state as Record<string, unknown> | undefined;
  if (typeof state?.free_space !== "number" || typeof state?.total_space !== "number") return null;
  return { free: state.free_space / 1e9, total: state.total_space / 1e9 };
});

const modes = [
  { label: "Video", value: "FUNCTION_MODE_NORMAL_VIDEO" },
  { label: "Photo", value: "FUNCTION_MODE_NORMAL_IMAGE" },
];

onMounted(() => void load());
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-center gap-3">
      <USelect v-model="mode" :items="modes" class="w-40" />
      <UButton
        label="Reload"
        icon="i-lucide-refresh-cw"
        color="neutral"
        variant="ghost"
        :loading="loading"
        @click="load"
      />
      <div class="ml-auto flex items-center gap-4 text-sm text-muted">
        <span v-if="battery !== null">
          <UIcon name="i-lucide-battery" class="mr-1 align-middle" />{{ battery }}%
        </span>
        <span v-if="storage">
          <UIcon name="i-lucide-hard-drive" class="mr-1 align-middle" />
          {{ storage.free.toFixed(1) }} / {{ storage.total.toFixed(0) }} GB
        </span>
        <span v-if="device.firmwareRevision">fw {{ device.firmwareRevision }}</span>
      </div>
    </div>

    <UAlert
      v-if="error"
      icon="i-lucide-triangle-alert"
      color="warning"
      variant="subtle"
      :title="error"
    />

    <div class="grid gap-4 sm:grid-cols-2">
      <UFormField v-for="picker in pickers" :key="picker.field" :label="picker.label">
        <USelect
          :model-value="settings[picker.field]"
          :items="options(picker.values)"
          :disabled="!isSupported(picker.option) || saving === picker.field"
          :loading="saving === picker.field"
          class="w-full"
          @update:model-value="(value) => update(picker.option, picker.field, value)"
        />
      </UFormField>
    </div>

    <div class="grid gap-6 sm:grid-cols-2">
      <UFormField
        v-for="slider in sliders"
        :key="slider.field"
        :label="`${slider.label}: ${settings[slider.field] ?? 0}`"
      >
        <USlider
          :model-value="Number(settings[slider.field] ?? slider.min)"
          :min="slider.min"
          :max="slider.max"
          :step="slider.step"
          :disabled="!isSupported(slider.option) || saving === slider.field"
          @update:model-value="(value) => update(slider.option, slider.field, Number(value))"
        />
      </UFormField>
    </div>

    <details class="text-sm">
      <summary class="cursor-pointer text-muted">Everything the camera reported</summary>
      <pre class="mt-2 max-h-96 overflow-auto rounded bg-elevated p-3 text-xs">{{
        JSON.stringify({ photography: settings, device }, null, 2)
      }}</pre>
    </details>
  </div>
</template>
```

- [ ] **Step 2: Create the page**

Create `app/pages/camera.vue`:

```vue
<script setup lang="ts">
const { isConnected } = useCamera();
useHead({ title: "Camera" });
</script>

<template>
  <UDashboardPanel id="camera">
    <template #header>
      <UDashboardNavbar title="Camera">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div v-if="!isConnected" class="py-16 text-center text-muted">
        Connect to the camera to control it.
      </div>
      <div v-else class="grid gap-8 xl:grid-cols-2">
        <LiveView />
        <CameraSettings />
      </div>
    </template>
  </UDashboardPanel>
</template>
```

- [ ] **Step 3: Typecheck, lint, build**

Run: `bun run typecheck && bun run lint && bun run generate`
Expected: no errors, build succeeds.

- [ ] **Step 4: Full test suite**

Run: `bun run vitest run && cd src-tauri && cargo test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add app/components/CameraSettings.client.vue app/pages/camera.vue
git commit -m "feat: pro camera settings page"
```

- [ ] **Step 6: Manual verification against the camera**

1. Join the camera's Wi-Fi, `bun run dev`, connect, open the Camera page.
2. Confirm live values appear — battery, storage, firmware, white balance, colour mode, zoom.
3. Change **white balance** first. It is visible in the live preview, instantly reversible, and harmless.
4. Confirm the preview shifts colour and the value persists after **Reload**.
5. Then try zoom and EV bias.

If a control snaps back, the camera did not include that option type in its
confirmation — the error line names the field. That is the designed behaviour,
not a bug, and tells us which option types need a different write shape.

---

## Self-Review

**Spec coverage** — against `2026-07-22-camera-settings-probe-findings.md`:

| Confirmed capability                                             | Task                                    |
| ---------------------------------------------------------------- | --------------------------------------- |
| Exposure mode/prog/manual, EV, ISO ceiling                       | 4, 5                                    |
| Metering                                                         | 4 (readable); UI in a follow-up         |
| White balance + Kelvin value                                     | 4, 5                                    |
| Gamma, colour mode, brightness/contrast/saturation/hue/sharpness | 4, 5                                    |
| Zoom (`ZOOM_SCALE`), focal length, FOV                           | 4, 5                                    |
| Resolution, bitrate, formats                                     | 4 (readable); UI in a follow-up         |
| Capture params (self-timer, burst, AEB)                          | 4 (readable); UI in a follow-up         |
| Stabilisation                                                    | 4 (readable); UI in a follow-up         |
| Battery, storage, firmware                                       | 5                                       |
| proto3 default-omission caveat                                   | Task 2 `isDefault`, Task 4 `$supported` |
| Batching so one bad option cannot spoil a reply                  | Task 4 `readBatched`                    |
| Unknown fields preserved                                         | Task 2 `$unknown`                       |

The raw dump in Task 5 keeps every read field visible even where no control exists yet, so nothing confirmed by the probe is hidden.

**Placeholder scan:** no TBDs; every code step is complete.

**Type consistency:** `ProtoObject`/`ProtoValue` are defined in Task 2 and used under those names in Tasks 4 and 5. `MSG`, `encodeMessage`, `decodeMessage`, `enumNames`, `OPTION_TYPE`, `PHOTOGRAPHY_OPTION_TYPE`, `FUNCTION_MODE` are exported in Task 2 and imported unchanged in Task 4. `lunaClient.command` is added in Task 4 Step 1 and used in Task 4 Step 2. Rust `luna_command` in Task 3 matches the `invoke("luna_command", { code, body })` call.
