#!/usr/bin/env node
// Camera protocol calibration. Read-only: only GET_* is ever sent.
//
// WHY THIS EXISTS: the vendored protobuf extraction is 2020-era and this camera
// is not. Every picture-profile field we have checked disagrees with it — the
// colour modes are renumbered, the filters live on a field labelled "gamma" at
// numbers the enum has never heard of, and filter strength is a field the
// extraction lacks entirely. A firmware update can renumber any of it again, at
// which point the app silently writes wrong values and confidently mislabels
// what it reads. That failure is invisible: writes are accepted, read-backs
// agree, and only the camera's own screen shows the truth.
//
// AFTER A FIRMWARE UPDATE, RUN THIS:
//
//   node scripts/probe-colorspace.mjs calibrate
//
// It walks you through every colour mode, filter and strength in one pass and
// prints a paste-ready ENUM_OVERRIDES block for scripts/build-schema.mjs. It
// also shouts if two settings read the same number, which always means the
// camera did not actually change between two steps. Full write-up, including
// how each of these was found:
//   docs/superpowers/specs/2026-07-25-camera-protocol-calibration.md
//
// The commands below are the tools `calibrate` is built from, for hunting a
// lever that has moved somewhere new.
//
// The question they answer: when the *camera* changes a setting, which field on
// the wire actually moves? We cannot sniff the phone app's traffic, but we do
// not need to — we only need the camera's state before and after, and whoever
// makes the change (phone app, camera UI) is irrelevant.
//
// `pair` is the command to reach for. It snapshots, waits at a prompt while you
// change the setting on the camera, snapshots again and diffs — all on one
// connection. Prefer it over two `snapshot` calls: pasting those together runs
// them back to back with nobody touching the camera in between, and the diff
// then honestly reports that nothing moved. Three rounds were lost that way.
//
//   node scripts/probe-colorspace.mjs pair nofilter leicavivid --all
//
// The manual two-step, when you need snapshots minutes or reboots apart:
//
//   1. Put the camera in Standard, then:  node scripts/probe-colorspace.mjs snapshot standard
//   2. Switch it to i-Log, then:          node scripts/probe-colorspace.mjs snapshot ilog
//   3. Switch it to Dolby Vision, then:   node scripts/probe-colorspace.mjs snapshot dolby
//   4. node scripts/probe-colorspace.mjs diff standard ilog
//      node scripts/probe-colorspace.mjs diff standard dolby
//
// `monitor` is for GESTURES rather than settings — a tap-to-focus or a track
// drag is an event, not a state that sits still to be diffed. It polls the
// option fields AND listens for camera notifications on one connection, stamps
// everything with a time, and lets you press Enter to drop a labelled marker in.
// Do one thing on the camera, mark it, do the next; the markers are what make
// the log readable afterwards. Writes ./probe-out/monitor.log on Ctrl-C.
//
//   node scripts/probe-colorspace.mjs monitor [--interval 700] [--max 200]
//
// `listen` is the passive half on its own: notifications only, nothing sent.
//
//   node scripts/probe-colorspace.mjs listen
//
// `watch` polls continuously and prints changes as they happen, for when the
// camera can be driven while this stays connected:
//
//   node scripts/probe-colorspace.mjs watch
//
// `--all` widens either mode from the curated suspect list below to a sweep of
// option type NUMBERS 1..--max, keeping every field that comes back including
// ones the schema cannot name. That numeric range is the point: the vendored
// enum stops at 54 and the Luna's filters have no entry in it at all, so a
// sweep bounded by the enum would come back clean while missing them entirely.
// Snapshots taken with and without `--all` are not comparable, so use the same
// flag on both sides of a diff.
//
//   node scripts/probe-colorspace.mjs snapshot nofilter --all
//
// `scan` goes further still: it walks option-type NUMBERS past the end of the
// vendored enum to find types this firmware answers to and the schema has never
// heard of. Use it when a setting has no field in the schema at all.
//
//   node scripts/probe-colorspace.mjs scan [--max 200]
//
// Values are reported as RAW WIRE NUMBERS with the schema's name beside them.
// That ordering is deliberate: the vendored schema is 2020-era and this camera
// has already been caught out of range (photo_sub_mode = 8 has no name), so a
// name is a hint and the number is the evidence.
//
// Writes ./probe-out/colorspace-<label>.json

import fs from "node:fs";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CODE, fieldVarint, LunaSession } from "./lib/ucd2.mjs";
import { decodeRaw } from "./lib/protobuf.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(fs.readFileSync(path.join(here, "luna-protocol-schema.json"), "utf8"));

const OUT_DIR = path.resolve("probe-out");

const args = process.argv.slice(2);
const command = args[0] ?? "snapshot";
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const HOST = flag("host", "192.168.42.1");
const PORT = Number(flag("port", "6666"));

const nameOf = (enumName, value) => schema.enums[enumName]?.[String(value)] ?? null;
const valueOf = (enumName, name) =>
  Number(Object.entries(schema.enums[enumName] ?? {}).find(([, n]) => n === name)?.[0] ?? -1);

// Extra message codes the settings probe never tried. Both are plausible homes
// for a picture profile the PhotographyOptions blob does not carry.
const CODE_GET_SUBMODE_OPTIONS = 43;
const CODE_GET_MULTI_PHOTOGRAPHY_OPTIONS = 68;

/**
 * Every OTHER read command this firmware might answer, asked on each snapshot so
 * a diff covers them for free.
 *
 * Sweeping option types found nothing for the Leica filters, which leaves the
 * possibility that they are not an "option" at all but live behind a command of
 * their own. So we ask each read command and compare its whole reply.
 *
 * ONLY commands the schema names PHONE_COMMAND_GET_* appear here. Codes absent
 * from the enum are deliberately not probed: an unknown code could be a setter
 * or something destructive, and a read-only probe has no business guessing.
 * File, thumbnail and gyro reads are also left out — they answer with payloads
 * that change constantly and would bury a real signal in noise.
 */
const commandProbes = (videoMode) => [
  { key: "captureStatus", code: 15, label: "GET_CURRENT_CAPTURE_STATUS" },
  { key: "timelapseOptions", code: 17, label: "GET_TIMELAPSE_OPTIONS" },
  { key: "btPeripherals", code: 29, label: "GET_CONNECTED_BT_PERIPHERALS" },
  {
    // Code 43 has no message shape anywhere in the extraction, so the body is a
    // guess: sub-mode plus function mode, the two things every other per-mode
    // request carries. An empty reply means "wrong shape" at least as often as
    // it means "nothing there".
    key: "submodeOptions",
    code: CODE_GET_SUBMODE_OPTIONS,
    label: "GET_SUBMODE_OPTIONS",
    body: Buffer.concat([fieldVarint(1, 0), fieldVarint(2, videoMode)]),
  },
  { key: "syncCaptureMode", code: 55, label: "GET_SYNC_CAPTURE_MODE" },
  { key: "temporaryOptions", code: 59, label: "GET_TEMPORARY_OPTIONS_SWITCH" },
  { key: "flowstateEnable", code: 64, label: "GET_FLOWSTATE_ENABLE" },
  { key: "activeSensor", code: 66, label: "GET_ACTIVE_SENSOR" },
  {
    // GetMultiPhotographyOptions wants option_types AND device AND function_mode.
    // The first attempt sent only a photography option type, which is the wrong
    // vocabulary entirely — hence its empty reply.
    key: "multiPhotography",
    code: CODE_GET_MULTI_PHOTOGRAPHY_OPTIONS,
    label: "GET_MULTI_PHOTOGRAPHY_OPTIONS",
    body: Buffer.concat([
      ...[1, 2, 3, 4].map((type) => fieldVarint(1, type)),
      fieldVarint(2, 1), // SENSOR_DEVICE_FRONT
      fieldVarint(3, videoMode),
    ]),
  },
  { key: "buttonPressParam", code: 104, label: "GET_BUTTON_PRESS_PARAM" },
  { key: "wifiConnectionInfo", code: 113, label: "GET_WIFI_CONNECTION_INFO" },
];

/**
 * Every field worth suspecting, and why.
 *
 * `color_mode` is the field the app drives today and the one that reads back
 * COLOR_MODE_LOG on a camera sitting in Standard, so it is suspect number one
 * — either it is dead, or its numbering has drifted. The rest are the other
 * places a "picture profile" could plausibly live on this firmware.
 */
const PHOTOGRAPHY_WATCH = [
  {
    type: 35,
    field: 35,
    label: "color_mode",
    enum: "insta360.messages.PhotographyOptions.COLOR_MODE",
  },
  { type: 18, field: 18, label: "gamma_mode", enum: "insta360.messages.GammaMode" },
  { type: 31, field: 31, label: "record_resolution", enum: "insta360.messages.VideoResolution" },
  { type: 32, field: 32, label: "video_bitrate", enum: null },
  { type: 25, field: 25, label: "raw_capture_type", enum: "insta360.messages.RawCaptureType" },
  { type: 33, field: 33, label: "fov_type", enum: "insta360.messages.PhotographyOptions.Fov_Type" },
  { type: 40, field: 40, label: "photo_resolution", enum: "insta360.messages.PhotoSize" },
];

const DEVICE_WATCH = [
  { type: 41, field: 41, label: "video_sub_mode", enum: "insta360.messages.VideoSubMode" },
  { type: 40, field: 40, label: "photo_sub_mode", enum: "insta360.messages.PhotoSubMode" },
  {
    type: 66,
    field: 66,
    label: "video_encode_type",
    enum: "insta360.messages.Options.VideoEncodeType",
  },
  // Not in the camera's acknowledged list, but ask anyway — an unacknowledged
  // type that still answers would be the most interesting result of the run.
  { type: 28, field: 28, label: "gamma_mode(device)", enum: "insta360.messages.GammaMode" },
];

// Dolby Vision has no COLOR_MODE-shaped home in this schema, but it does have a
// whole shooting mode (VIDEO_HDR / FUNCTION_MODE_HDR_VIDEO / Capture_MODE_HDR).
// If selecting it moves the camera into that function mode, its settings live
// under a different blob entirely — so read all four.
const FUNCTION_MODES = [
  "FUNCTION_MODE_NORMAL_VIDEO",
  "FUNCTION_MODE_HDR_VIDEO",
  "FUNCTION_MODE_NORMAL_IMAGE",
  "FUNCTION_MODE_HDR_IMAGE",
];

/** Pull `value` (field 2) out of a Get*Resp and return its raw varint fields. */
function valueFields(body) {
  const out = new Map();
  for (const record of decodeRaw(body)) {
    if (record.field !== 2 || record.wire !== 2) continue;
    for (const inner of decodeRaw(record.value)) {
      if (inner.wire === 0) out.set(inner.field, inner.value);
    }
  }
  return out;
}

/**
 * Every field in `value`, nested ones included, keyed by field number and
 * rendered as a comparable scalar. `--all` uses this rather than valueFields:
 * when hunting a lever we cannot name in advance, a field the schema has no
 * name for is exactly the one we are looking for, so nothing gets dropped.
 */
function allValueFields(body) {
  const out = new Map();
  for (const record of decodeRaw(body)) {
    if (record.field !== 2 || record.wire !== 2) continue;
    for (const inner of decodeRaw(record.value)) {
      out.set(
        inner.field,
        inner.value instanceof Buffer ? `0x${inner.value.toString("hex")}` : inner.value,
      );
    }
  }
  return out;
}

/** Which of the requested option types the camera echoed back as recognised. */
function echoedTypes(body) {
  const out = new Set();
  for (const record of decodeRaw(body)) {
    if (record.field === 1 && record.wire === 0) out.add(record.value);
  }
  return out;
}

/**
 * Code 8293: the camera announcing that a photography option changed.
 *
 * Not in the extraction, found by watching the resolution picker. Shape is
 * { 1: option type, 2: a PhotographyOptions fragment holding the new value,
 * 3: function mode } — so it names what changed, to what, and where, which is
 * everything a polling loop was being used to infer.
 *
 * This is the good way to measure any photography setting: cycle it on the
 * camera and read the announcements, instead of diffing snapshots and hoping
 * the poll lands between changes.
 */
const CODE_OPTION_CHANGED = 8293;

function describeOptionChange(body) {
  const top = decodeRaw(body);
  const type = top.find((r) => r.field === 1 && r.wire === 0)?.value;
  const fragment = top.find((r) => r.field === 2 && r.wire === 2)?.value;
  const mode = top.find((r) => r.field === 3 && r.wire === 0)?.value;
  if (type === undefined || !fragment) return null;

  const typeName = nameOf("insta360.messages.PhotographyOptionType", type) ?? `#${type}`;
  const modeName = nameOf("insta360.messages.FunctionMode", mode) ?? `#${mode}`;
  const spec = schema.messages["insta360.messages.PhotographyOptions"]?.[String(type)];

  const values = decodeRaw(fragment).map((record) => {
    if (record.wire !== 0) return `field ${record.field} = 0x${record.value.toString("hex")}`;
    const named = spec?.ref ? nameOf(spec.ref, record.value) : null;
    return `${record.value}${named ? `  ${named}` : spec?.ref ? "  << NOT IN ENUM >>" : ""}`;
  });

  const unnamed = decodeRaw(fragment).some(
    (record) => record.wire === 0 && spec?.ref && !nameOf(spec.ref, record.value),
  );
  const raw = decodeRaw(fragment).find((r) => r.wire === 0)?.value;
  return {
    text: `${typeName} = ${values.join(", ")}   [${modeName}]`,
    unnamed,
    raw,
    typeName,
  };
}

const describe = (raw, enumName) => {
  if (raw === undefined) return "(omitted — proto3 default, or unsupported)";
  const name = enumName ? nameOf(enumName, raw) : null;
  return enumName ? `${raw}  ${name ?? "<< NO NAME IN SCHEMA >>"}` : String(raw);
};

async function readGroup(session, { code, extra, watch }) {
  const readings = {};
  // One option type per request. Batching is faster but a single unsupported
  // type can spoil a whole reply, and here a missing field is the finding.
  for (const item of watch) {
    const body = Buffer.concat([fieldVarint(1, item.type), extra ?? Buffer.alloc(0)]);
    const frame = await session.send(code, body);
    if (!frame) {
      readings[item.label] = { raw: null, note: "timed out" };
      continue;
    }
    if (!frame.body?.length) {
      readings[item.label] = { raw: null, note: "empty response" };
      continue;
    }
    const raw = valueFields(frame.body).get(item.field);
    readings[item.label] = {
      raw: raw ?? null,
      acknowledged: echoedTypes(frame.body).has(item.type),
      shown: describe(raw, item.enum),
      hex: frame.body.toString("hex"),
    };
  }
  return readings;
}

/** Fire an unexplored command and keep whatever comes back, verbatim. */
async function probeUnknown(session, code, body, label) {
  const frame = await session.send(code, body);
  if (!frame) return { label, note: "timed out" };
  if (!frame.body?.length) return { label, note: "empty response" };
  return {
    label,
    hex: frame.body.toString("hex"),
    records: decodeRaw(frame.body).map((r) => ({
      field: r.field,
      wire: r.wire,
      value: r.value instanceof Buffer ? r.value.toString("hex") : r.value,
    })),
  };
}

/**
 * Sweep every option type an enum defines and keep every field that comes back,
 * named or not. Types go out in batches because one request per type is 50-odd
 * round trips per function mode; a batch that comes back empty is retried one
 * type at a time, since a single unsupported type can spoil a whole reply.
 */
async function sweep(session, { code, extra, max }) {
  // Numeric range, NOT the vendored enum's keys. The enum stops at 54 and the
  // Luna's filters have no entry in it at all, so sweeping only what the schema
  // names would come back looking clean while missing the thing entirely.
  const types = Array.from({ length: max }, (_, i) => i + 1);

  const readings = {};
  const record = (fields) => {
    for (const [field, value] of fields) {
      const spec =
        schema.messages[
          code === CODE.GET_OPTIONS
            ? "insta360.messages.Options"
            : "insta360.messages.PhotographyOptions"
        ]?.[String(field)];
      readings[`${field}:${spec?.name ?? "UNNAMED"}`] = { raw: value, enum: spec?.ref ?? null };
    }
  };

  const ask = async (batch) => {
    const body = Buffer.concat([...batch.map((t) => fieldVarint(1, t)), extra ?? Buffer.alloc(0)]);
    const frame = await session.send(code, body);
    return frame?.body?.length ? frame.body : null;
  };

  for (let i = 0; i < types.length; i += 12) {
    const batch = types.slice(i, i + 12);
    const body = await ask(batch);
    if (body) {
      record(allValueFields(body));
      continue;
    }
    for (const type of batch) {
      const single = await ask([type]);
      if (single) record(allValueFields(single));
    }
  }
  return readings;
}

async function collect(session, { all = false, max = 200 } = {}) {
  const snapshot = { device: {}, photography: {}, unknown: {} };

  snapshot.device = all
    ? await sweep(session, { code: CODE.GET_OPTIONS, max })
    : await readGroup(session, { code: CODE.GET_OPTIONS, watch: DEVICE_WATCH });

  for (const modeName of FUNCTION_MODES) {
    const mode = valueOf("insta360.messages.FunctionMode", modeName);
    if (mode < 0) continue;
    snapshot.photography[modeName] = all
      ? await sweep(session, {
          code: CODE.GET_PHOTOGRAPHY_OPTIONS,
          extra: fieldVarint(2, mode),
          max,
        })
      : await readGroup(session, {
          code: CODE.GET_PHOTOGRAPHY_OPTIONS,
          extra: fieldVarint(2, mode),
          watch: PHOTOGRAPHY_WATCH,
        });
  }

  const videoMode = valueOf("insta360.messages.FunctionMode", "FUNCTION_MODE_NORMAL_VIDEO");
  for (const probe of commandProbes(videoMode)) {
    snapshot.unknown[probe.key] = await probeUnknown(
      session,
      probe.code,
      probe.body ?? Buffer.alloc(0),
      `${probe.label} (${probe.code})`,
    );
  }

  return snapshot;
}

/** Flatten a snapshot to `path -> raw` so two runs can be compared field-wise. */
function flatten(snapshot) {
  const flat = {};
  for (const [label, reading] of Object.entries(snapshot.device)) {
    flat[`device.${label}`] = reading.raw;
  }
  for (const [mode, readings] of Object.entries(snapshot.photography)) {
    for (const [label, reading] of Object.entries(readings)) {
      flat[`${mode}.${label}`] = reading.raw;
    }
  }
  for (const [key, result] of Object.entries(snapshot.unknown)) {
    flat[`unknown.${key}`] = result.hex ?? result.note ?? null;
  }
  return flat;
}

/**
 * Walk option-type NUMBERS past the end of the vendored enum, looking for ones
 * this firmware answers to.
 *
 * `--all` cannot find these: the camera only returns what you ask for, and the
 * extraction only knows types 1-54. The Luna's Leica/cinematic filters and their
 * intensity have no field anywhere in that extraction, so if they are reachable
 * at all they are reachable through a type nobody has asked for yet.
 *
 * An echo in field 1 is the camera saying "I know that type" — that, not the
 * presence of a value, is the signal. A recognised type with no value is still
 * a hit; it just happens to be sitting at its proto3 default.
 */
async function scanTypes(session, { code, extra, optionTypeEnum, message, max }) {
  const known = schema.enums[optionTypeEnum] ?? {};
  const fields = schema.messages[message] ?? {};
  const hits = [];

  for (let type = 1; type <= max; type++) {
    const body = Buffer.concat([fieldVarint(1, type), extra ?? Buffer.alloc(0)]);
    const frame = await session.send(code, body, 2500);
    if (!frame?.body?.length) continue;

    // The echo in field 1 is NOT evidence of support. Asked for photography
    // types 1-400 this camera echoed 399 of them, including hundreds that
    // plainly do not exist — it simply parrots the request. Only a returned
    // VALUE means the type is real, so that is the whole test.
    const values = [...allValueFields(frame.body)].map(([field, raw]) => ({
      field,
      name: fields[String(field)]?.name ?? null,
      raw,
    }));
    if (values.length === 0) continue;
    hits.push({ type, name: known[String(type)] ?? null, values });
  }
  return hits;
}

function reportScan(title, hits) {
  console.log(`\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}`);
  const novel = hits.filter((hit) => !hit.name);
  console.log(`${hits.length} option type(s) returned a value, ${novel.length} of them unnamed\n`);

  if (novel.length === 0) {
    console.log("No option types beyond the vendored enum returned anything. Whatever");
    console.log("we are hunting is not reachable as a photography/device option here.");
  } else {
    console.log("UNNAMED — these postdate the schema and are the interesting ones:");
    for (const hit of novel) {
      const shown = hit.values
        .map((v) => `field ${v.field}${v.name ? ` (${v.name})` : ""} = ${v.raw}`)
        .join(", ");
      console.log(`  type ${String(hit.type).padStart(3)}   ${shown}`);
    }
  }
  console.log("\nTypes that answered with nothing are not listed: this camera echoes");
  console.log("any type number back, so silence and support look identical.");

  const unnamedFields = hits.flatMap((hit) =>
    hit.values.filter((v) => !v.name).map((v) => `${v.field} (via type ${hit.type})`),
  );
  if (unnamedFields.length > 0) {
    console.log("\nUNNAMED FIELDS returned by known types:");
    for (const entry of new Set(unnamedFields)) console.log(`  field ${entry}`);
  }
}

async function scanCommand(max) {
  await withSession(async (session) => {
    console.log(`scanning option types 1-${max} on ${HOST}`);
    console.log("read-only: only GET_* is sent. This takes a couple of minutes.");

    const mode = valueOf("insta360.messages.FunctionMode", "FUNCTION_MODE_NORMAL_VIDEO");
    reportScan(
      `PHOTOGRAPHY OPTION TYPES — FUNCTION_MODE_NORMAL_VIDEO (schema knows 1-54)`,
      await scanTypes(session, {
        code: CODE.GET_PHOTOGRAPHY_OPTIONS,
        extra: fieldVarint(2, mode),
        optionTypeEnum: "insta360.messages.PhotographyOptionType",
        message: "insta360.messages.PhotographyOptions",
        max,
      }),
    );

    reportScan(
      `DEVICE OPTION TYPES (schema knows up to 124)`,
      await scanTypes(session, {
        code: CODE.GET_OPTIONS,
        optionTypeEnum: "insta360.messages.OptionType",
        message: "insta360.messages.Options",
        max,
      }),
    );
  });
}

/** How a reading prints, whether it came from a curated watch or an `--all` sweep. */
const shownValue = (reading) =>
  reading.shown ?? reading.note ?? describe(reading.raw ?? undefined, reading.enum);

function render(snapshot) {
  const lines = [];
  lines.push("DEVICE OPTIONS (GET_OPTIONS)");
  for (const [label, reading] of Object.entries(snapshot.device)) {
    const ack = reading.acknowledged === false ? "  [not acknowledged]" : "";
    lines.push(`  ${label.padEnd(24)} ${reading.shown ?? reading.note}${ack}`);
  }
  for (const [mode, readings] of Object.entries(snapshot.photography)) {
    lines.push(`\nPHOTOGRAPHY OPTIONS — ${mode}`);
    for (const [label, reading] of Object.entries(readings)) {
      const ack = reading.acknowledged === false ? "  [not acknowledged]" : "";
      lines.push(`  ${label.padEnd(28)} ${shownValue(reading)}${ack}`);
    }
  }
  lines.push("\nUNEXPLORED COMMANDS");
  for (const result of Object.values(snapshot.unknown)) {
    lines.push(`  ${result.label}`);
    lines.push(`    ${result.note ?? result.hex}`);
  }
  return lines.join("\n");
}

async function withSession(run) {
  const session = new LunaSession(HOST, PORT);
  try {
    await session.connect();
  } catch (error) {
    console.error(`cannot reach the camera at ${HOST}:${PORT} — ${error.message}`);
    process.exitCode = 1;
    return;
  }
  // The camera wants a moment after the stream hello before it answers commands
  await new Promise((done) => setTimeout(done, 1500));
  try {
    await run(session);
  } finally {
    session.close();
  }
}

async function snapshotCommand(label, all, max) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await withSession(async (session) => {
    if (all) console.log("sweeping every option type — this takes a minute\n");
    const snapshot = await collect(session, { all, max });
    const file = path.join(OUT_DIR, `colorspace-${label}.json`);
    fs.writeFileSync(file, JSON.stringify(snapshot, null, 2));
    console.log(`snapshot "${label}" against ${HOST}\n`);
    console.log(render(snapshot));
    console.log(`\nwritten to ${file}`);
  });
}

function diffCommand(a, b) {
  const read = (label) => {
    const file = path.join(OUT_DIR, `colorspace-${label}.json`);
    if (!fs.existsSync(file)) {
      console.error(`no snapshot "${label}" — expected ${file}`);
      process.exit(1);
    }
    return flatten(JSON.parse(fs.readFileSync(file, "utf8")));
  };
  const left = read(a);
  const right = read(b);
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();

  const changed = keys.filter((key) => String(left[key]) !== String(right[key]));
  console.log(`${a} -> ${b}\n`);
  if (changed.length === 0) {
    console.log("NOTHING MOVED.");
    console.log("");
    console.log("The camera's colour mode is not reachable through any field this");
    console.log("probe watches. Widen PHOTOGRAPHY_WATCH / DEVICE_WATCH before");
    console.log("concluding the setting is unreachable.");
    return;
  }
  console.log(`${changed.length} field(s) moved — these are the levers:\n`);
  for (const key of changed) {
    console.log(`  ${key.padEnd(46)} ${left[key]}  ->  ${right[key]}`);
  }
}

const waitForCamera = (instruction) =>
  new Promise((done) => {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`  ${instruction}`);
    console.log("  Check the camera's preview actually looks different.");
    console.log(`${"=".repeat(60)}`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("\npress Enter when the camera is showing it... ", () => {
      rl.close();
      done();
    });
  });

/**
 * Snapshot, wait for a human to change the setting, snapshot again, diff.
 *
 * Pasting two `snapshot` commands at once silently defeats the whole experiment:
 * they run back to back, nobody touches the camera in between, and the diff
 * truthfully reports that nothing moved. Three rounds were lost to exactly that.
 * Holding both halves inside one command — and one connection — makes the pause
 * for the camera unskippable.
 */
async function pairCommand(before, after, all, max) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await withSession(async (session) => {
    const take = async (label) => {
      const snapshot = await collect(session, { all, max });
      fs.writeFileSync(
        path.join(OUT_DIR, `colorspace-${label}.json`),
        JSON.stringify(snapshot, null, 2),
      );
      return snapshot;
    };

    // Prompt for the "before" state too, rather than assuming the camera is
    // already in it. Snapshotting straight away records whatever the previous
    // run left behind, and a baseline that is really someone else's leftovers
    // makes the diff describe a change that never happened.
    await waitForCamera(`NOW SET THE CAMERA TO: ${before}`);
    console.log(`\ntaking "${before}"...`);
    await take(before);

    await waitForCamera(`NOW SET THE CAMERA TO: ${after}`);

    console.log(`\ntaking "${after}"...`);
    await take(after);

    console.log("");
    diffCommand(before, after);
  });
}

/**
 * `pair` for a whole list of settings: step through each one, then print a
 * matrix of every field that varied across the run.
 *
 * Pairs answer "which field is the lever". A series answers "and what is each
 * setting's number", which is the part that actually lets us drive the camera —
 * and it gets all of them in one connection instead of one run per value.
 */
async function seriesCommand(labels, all, max) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await withSession(async (session) => {
    const taken = [];
    for (const label of labels) {
      // Prompt for the FIRST label too. It used to snapshot immediately on the
      // assumption the camera was already in the starting state, which quietly
      // recorded whatever the previous run had left behind — and a first row
      // that is really the last run's leftovers looks exactly like a genuine
      // collision between two settings.
      await waitForCamera(`NOW SET THE CAMERA TO: ${label}`);

      const snapshot = await collect(session, { all, max });
      fs.writeFileSync(
        path.join(OUT_DIR, `colorspace-${label}.json`),
        JSON.stringify(snapshot, null, 2),
      );
      taken.push({ label, flat: flatten(snapshot) });
      console.log(`  captured "${label}"`);
    }

    // Only fields that actually vary are worth showing; everything else is the
    // camera's resting state and would bury the result.
    const keys = [...new Set(taken.flatMap((t) => Object.keys(t.flat)))].filter((key) => {
      const values = new Set(taken.map((t) => String(t.flat[key])));
      return values.size > 1;
    });

    console.log(`\n${"=".repeat(72)}\nFIELDS THAT VARIED ACROSS THE SERIES\n${"=".repeat(72)}\n`);
    if (keys.length === 0) {
      console.log("Nothing moved. Either the setting never changed on the camera,");
      console.log("or it is not carried by anything this probe reads.");
      return;
    }
    const width = Math.max(...labels.map((l) => l.length), 8);
    for (const key of keys) {
      console.log(key);
      for (const entry of taken) {
        console.log(`  ${entry.label.padEnd(width)}  ${entry.flat[key]}`);
      }
      console.log("");
    }
    console.log("Ignore media_time and battery_status — they move on their own.");
  });
}

/**
 * The whole calibration, in one run: every colour mode, every filter, every
 * strength, then a paste-ready ENUM_OVERRIDES block for build-schema.mjs.
 *
 * This exists because a firmware update can renumber any of these, and finding
 * that out the hard way costs a day. Every value below was measured, and every
 * one of them disagreed with the vendored extraction — so assume the next
 * firmware disagrees too and re-run this rather than trusting the checked-in
 * numbers. See docs/superpowers/specs/2026-07-25-camera-protocol-calibration.md.
 *
 * The prompts name settings as the CAMERA names them, so the operator never has
 * to translate between our enum names and what is on screen.
 */
const CALIBRATION = [
  {
    field: 35,
    key: "color",
    enumName: "insta360.messages.PhotographyOptions.COLOR_MODE",
    heading: "COLOUR MODE  (Pro > Color Mode)",
    steps: [
      { prompt: "Color Mode = Standard", name: "COLOR_MODE_NORMAL" },
      { prompt: "Color Mode = I-Log", name: "COLOR_MODE_LOG" },
      { prompt: "Color Mode = Dolby Vision", name: "COLOR_MODE_HDR" },
    ],
  },
  {
    field: 18,
    key: "filter",
    enumName: "insta360.messages.GammaMode",
    heading: "FILTER  (swipe from the right edge > Filter)",
    // Set Color Mode back to Standard and the resolution to 4K30 or lower
    // first: filters are unavailable above 4K60, and a greyed-out picker
    // records the previous filter again rather than the one being asked for.
    steps: [
      { prompt: "Filter = Original (none)", name: "FILTER_NONE" },
      { prompt: "Filter = Leica Natural", name: "FILTER_LEICA_NATURAL" },
      { prompt: "Filter = Leica Vivid", name: "FILTER_LEICA_VIVID" },
      { prompt: "Filter = Leica Chrome", name: "FILTER_LEICA_CHROME" },
      { prompt: "Filter = Pos Film", name: "FILTER_POS_FILM" },
      { prompt: "Filter = Neg Film", name: "FILTER_NEG_FILM" },
      { prompt: "Filter = CC Film", name: "FILTER_CC_FILM" },
      { prompt: "Filter = NC Film", name: "FILTER_NC_FILM" },
      { prompt: "Filter = Fresh", name: "FILTER_FRESH" },
      { prompt: "Filter = Cinematic", name: "FILTER_CINEMATIC" },
    ],
  },
  {
    field: 104,
    key: "strength",
    enumName: "insta360.messages.FilterIntensity",
    heading: "FILTER STRENGTH  (with a cinematic filter selected — Leica has none)",
    steps: [
      { prompt: "Keep Fresh selected, Strength = Low", name: "INTENSITY_LOW" },
      { prompt: "Strength = Medium", name: "INTENSITY_MEDIUM" },
      { prompt: "Strength = High", name: "INTENSITY_HIGH" },
    ],
  },
  {
    // The stills modes, which the extraction gets wrong in both directions: it
    // defines a Pano HDR the camera does not have, and cannot name the modes it
    // does (photo_sub_mode = 8 has no entry). Skip any step whose mode is not on
    // your camera's dial — a duplicate number in the output says as much.
    scope: "device",
    field: 40,
    key: "photo-modes",
    enumName: "insta360.messages.PhotoSubMode",
    heading: "STILLS MODES  (the capture-mode strip)",
    steps: [
      { prompt: "Mode = Photo", name: "PHOTO_SINGLE" },
      { prompt: "Mode = UltraPhoto", name: "PHOTO_ULTRA" },
      { prompt: "Mode = Pano, aspect 360", name: "PHOTO_PANO_360" },
      { prompt: "Mode = Pano, aspect 2:1", name: "PHOTO_PANO_2_1" },
    ],
  },
  {
    scope: "device",
    field: 41,
    key: "video-modes",
    enumName: "insta360.messages.VideoSubMode",
    heading: "VIDEO MODES  (the capture-mode strip)",
    steps: [
      { prompt: "Mode = Video", name: "VIDEO_NORMAL" },
      { prompt: "Mode = PureVideo", name: "VIDEO_PURE" },
      { prompt: "Mode = Slow-mo", name: "VIDEO_SLOW_MOTION" },
      { prompt: "Mode = Timelapse", name: "VIDEO_TIMELAPSE" },
    ],
  },
];

/**
 * Narrow a calibration run to the groups you actually need.
 *
 * Re-measuring one setting should not mean stepping through all ten filters
 * again. `--only` takes the listed groups, `--skip` drops them; an unknown name
 * is an error rather than a silent no-op, because a typo that quietly ran
 * everything would waste exactly the time this is meant to save.
 */
function selectGroups(only, skip) {
  const known = CALIBRATION.map((group) => group.key);
  const parse = (value) =>
    value
      ? value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  const wanted = parse(only);
  const unwanted = parse(skip);

  const unknown = [...wanted, ...unwanted].filter((name) => !known.includes(name));
  if (unknown.length > 0) {
    console.error(`unknown group(s): ${unknown.join(", ")}`);
    console.error(`known groups: ${known.join(", ")}`);
    process.exit(1);
  }

  return CALIBRATION.filter(
    (group) => (wanted.length === 0 || wanted.includes(group.key)) && !unwanted.includes(group.key),
  );
}

/**
 * Sit on the control socket and print every frame the camera sends unprompted.
 *
 * Colour Recovery moves nothing in photography or device options, but it plainly
 * changes the preview — so the likely home is the live-stream side, and the
 * camera announces those through CAMERA_NOTIFICATION_UPDATE_LIVE_STREAM_PARAMS
 * rather than parking them in an option you can read back.
 *
 * Purely passive: this sends no commands at all beyond the keepalive that holds
 * the session open. Anything printed is the camera talking on its own.
 */
async function listenCommand() {
  await withSession(async (session) => {
    const codes = schema.enums["insta360.messages.MessageCode"] ?? {};
    let seen = 0;

    session.onUnsolicited = (frame) => {
      // Frames with no code are transport-level keepalives, not protocol
      // messages. They arrive about once a second and would bury anything real.
      if (frame.code === undefined) return;
      seen += 1;
      if (frame.code === CODE_OPTION_CHANGED && frame.body?.length) {
        const changed = describeOptionChange(frame.body);
        if (changed) {
          console.log(`\n[${seen}] CHANGED  ${changed.text}`);
          return;
        }
      }
      const name = codes[String(frame.code)] ?? "(no name in schema)";
      console.log(`\n[${seen}] code ${frame.code}  ${name}`);
      if (!frame.body?.length) {
        console.log("     empty body");
        return;
      }
      console.log(`     ${frame.body.length}B  ${frame.body.toString("hex")}`);
      for (const record of decodeRaw(frame.body)) {
        const value =
          record.value instanceof Buffer ? `0x${record.value.toString("hex")}` : record.value;
        console.log(`       field ${record.field} (wire ${record.wire}) = ${value}`);
      }
    };

    console.log("listening — toggle the setting on the camera now. Ctrl-C to stop.\n");
    console.log("Nothing is sent to the camera; every line below is the camera");
    console.log("volunteering something.\n");

    // Hold the process open. The keepalive inside LunaSession does the rest.
    await new Promise(() => {});
  });
}

/**
 * Fire one command with a range of plausible request shapes.
 *
 * Some commands in the MessageCode enum have no message definition anywhere in
 * the extraction — GET_SUBMODE_OPTIONS (43) is the one that matters here. An
 * empty reply from a body we invented says "wrong shape" at least as often as
 * it says "nothing there", so guessing once and concluding is not good enough.
 *
 * Read-only by construction: the caller passes a code the schema names
 * PHONE_COMMAND_GET_*, and nothing here invents a code.
 */
function requestShapes(videoMode, imageMode) {
  const f = fieldVarint;
  const cat = (...parts) => Buffer.concat(parts);
  const optionTypes = (n) => cat(...Array.from({ length: n }, (_, i) => f(1, i + 1)));

  return [
    { label: "empty", body: Buffer.alloc(0) },
    { label: "f1=0", body: f(1, 0) },
    { label: "f1=videoMode", body: f(1, videoMode) },
    { label: "f2=videoMode", body: f(2, videoMode) },
    { label: "f1=0 f2=videoMode", body: cat(f(1, 0), f(2, videoMode)) },
    { label: "f1=videoMode f2=0", body: cat(f(1, videoMode), f(2, 0)) },
    { label: "f1=imageMode", body: f(1, imageMode) },
    { label: "f1=0 f2=imageMode", body: cat(f(1, 0), f(2, imageMode)) },
    // Sub-mode ids rather than function modes: VIDEO_NORMAL 0, VIDEO_PURE 11,
    // VIDEO_SLOW_MOTION 9, and the Pano stills sub-mode 8.
    { label: "f1=subMode(0)", body: f(1, 0) },
    { label: "f1=subMode(11)", body: f(1, 11) },
    { label: "f1=subMode(8)", body: f(1, 8) },
    { label: "f1=0 f2=11", body: cat(f(1, 0), f(2, 11)) },
    // option_types-shaped, the pattern every other Get* request follows
    { label: "f1=[1..12]", body: optionTypes(12) },
    { label: "f1=[1..12] f2=videoMode", body: cat(optionTypes(12), f(2, videoMode)) },
    { label: "f1=[1..12] f2=videoMode f3=1", body: cat(optionTypes(12), f(2, videoMode), f(3, 1)) },
    { label: "f1=[1..40]", body: optionTypes(40) },
    // GetGyro is `{ count: uint32 }`, and a batch read may want a real batch —
    // asking for one sample is not obviously a valid request.
    { label: "f1=10 (count)", body: f(1, 10) },
    { label: "f1=100 (count)", body: f(1, 100) },
    { label: "f1=200 (count)", body: f(1, 200) },
    { label: "f1=1 f2=0", body: cat(f(1, 1), f(2, 0)) },
  ];
}

async function shapesCommand(code) {
  const name = schema.enums["insta360.messages.MessageCode"]?.[String(code)];
  if (!name?.startsWith("PHONE_COMMAND_GET_")) {
    console.error(`refusing code ${code}: the schema names it "${name ?? "nothing"}".`);
    console.error("Only commands the schema names PHONE_COMMAND_GET_* are safe to fire blind.");
    process.exit(1);
  }

  await withSession(async (session) => {
    const videoMode = valueOf("insta360.messages.FunctionMode", "FUNCTION_MODE_NORMAL_VIDEO");
    const imageMode = valueOf("insta360.messages.FunctionMode", "FUNCTION_MODE_NORMAL_IMAGE");
    console.log(`trying request shapes against code ${code} (${name})\n`);

    let answered = 0;
    for (const shape of requestShapes(videoMode, imageMode)) {
      const frame = await session.send(code, shape.body, 3000);
      const reply = !frame ? "timed out" : !frame.body?.length ? "empty" : null;
      if (reply) {
        console.log(`  ${shape.label.padEnd(30)} ${reply}`);
        continue;
      }
      answered += 1;
      console.log(
        `  ${shape.label.padEnd(30)} ${frame.body.length}B  ${frame.body.toString("hex")}`,
      );
      for (const record of decodeRaw(frame.body)) {
        const value =
          record.value instanceof Buffer ? `0x${record.value.toString("hex")}` : record.value;
        console.log(`      field ${record.field} (wire ${record.wire}) = ${value}`);
      }
    }

    console.log(
      answered === 0
        ? "\nNo shape got an answer. This command is not simply mis-shaped — the\ncamera has nothing to say to it."
        : `\n${answered} shape(s) answered. The ones with a body are the real request form.`,
    );
  });
}

/**
 * Watch everything at once while you use the camera, and let you mark the moment.
 *
 * `pair` and `series` compare two steady states, which is useless for a gesture:
 * a tap-to-focus or a track drag is an event, not a setting that sits still to
 * be read. So this polls the option fields AND listens for notifications on the
 * same connection, stamps everything with a time, and lets you press Enter to
 * drop a labelled marker into the stream.
 *
 * Read-only: the poll sends GET_* and nothing else.
 *
 * Use it by starting it, then doing ONE thing on the camera, pressing Enter to
 * mark it, and doing the next. The markers are what make the log readable
 * afterwards — without them a wall of timestamps tells you nothing about which
 * line was your tap.
 */
async function monitorCommand(max, intervalMs) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const logFile = path.join(OUT_DIR, "monitor.log");
  const lines = [];
  const started = Date.now();

  const stamp = () => `${((Date.now() - started) / 1000).toFixed(1)}s`.padStart(7);
  const say = (text) => {
    lines.push(text);
    console.log(text);
  };

  await withSession(async (session) => {
    const codes = schema.enums["insta360.messages.MessageCode"] ?? {};

    let keepalives = 0;
    let awaiting = null;
    const labelled = [];
    session.onUnsolicited = (frame) => {
      // See listenCommand: codeless frames are transport keepalives. Counted
      // rather than printed, so their absence is still visible if it matters.
      if (frame.code === undefined) {
        keepalives += 1;
        return;
      }
      if (frame.code === CODE_OPTION_CHANGED && frame.body?.length) {
        const changed = describeOptionChange(frame.body);
        if (changed) {
          say(`${stamp()}  CHANGED  ${changed.text}`);
          if (changed.unnamed) {
            // The schema has no name for this one, and the camera's screen is
            // the only place the answer exists. Ask while it is on screen —
            // reconstructing it afterwards from the order of a log is guesswork.
            awaiting = { raw: changed.raw, typeName: changed.typeName };
            say(`         ^^ NO NAME. Type what the camera shows, then Enter.`);
          }
          return;
        }
      }
      const name = codes[String(frame.code)] ?? "UNNAMED CODE";
      const body = frame.body?.length ? frame.body.toString("hex") : "(empty)";
      say(`${stamp()}  PUSH  code ${frame.code} ${name}  ${body}`);
    };

    // One function mode, not four. A gesture wants to be noticed quickly, and
    // the picture-profile fields mirror across modes anyway.
    const videoMode = valueOf("insta360.messages.FunctionMode", "FUNCTION_MODE_NORMAL_VIDEO");
    const sample = async () => ({
      ...Object.fromEntries(
        Object.entries(await sweep(session, { code: CODE.GET_OPTIONS, max })).map(([k, v]) => [
          `device.${k}`,
          v.raw,
        ]),
      ),
      ...Object.fromEntries(
        Object.entries(
          await sweep(session, {
            code: CODE.GET_PHOTOGRAPHY_OPTIONS,
            extra: fieldVarint(2, videoMode),
            max,
          }),
        ).map(([k, v]) => [`photo.${k}`, v.raw]),
      ),
    });

    say(`monitoring ${HOST} — option types 1-${max}, polling every ${intervalMs}ms`);
    say("Do ONE thing on the camera, then press Enter to mark it. Ctrl-C to stop.\n");

    let previous = await sample();
    say(`${stamp()}  baseline captured, ${Object.keys(previous).length} fields\n`);

    let markers = 0;
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", (text) => {
      const label = text.trim();
      // A typed line answers the outstanding "what is this?" if there is one,
      // which is what turns a log of bare numbers into a usable mapping.
      if (awaiting && label) {
        say(`${stamp()}  LABEL  ${awaiting.typeName} ${awaiting.raw} = ${label}`);
        labelled.push(`${awaiting.typeName} ${awaiting.raw} = ${label}`);
        awaiting = null;
        return;
      }
      markers += 1;
      say(`\n${stamp()}  ===== MARK ${markers}${label ? `: ${label}` : ""} =====`);
    });

    process.on("SIGINT", () => {
      fs.writeFileSync(logFile, lines.join("\n"));
      console.log(`\n\n${keepalives} keepalive frame(s) ignored.`);
      if (labelled.length > 0) {
        console.log(`\n${labelled.length} value(s) you named:`);
        for (const entry of labelled) console.log(`  ${entry}`);
      }
      console.log(`\nwritten to ${logFile}`);
      process.exit(0);
    });

    for (;;) {
      await new Promise((done) => setTimeout(done, intervalMs));
      const next = await sample();
      for (const key of Object.keys(next)) {
        // media_time and battery move on their own; they would bury everything
        if (key.includes("media_time") || key.includes("battery_status")) continue;
        if (String(previous[key]) !== String(next[key])) {
          say(`${stamp()}  ${key.padEnd(34)} ${previous[key]}  ->  ${next[key]}`);
        }
      }
      previous = next;
    }
  });
}

/**
 * A live attitude readout, for working on anything gimbal-shaped.
 *
 * GET_GYRO answers with a blob of IMU samples — `Gyro { ax, ay, az, gx, gy, gz }`,
 * six doubles each, accelerometer then gyroscope. Unlike every setting we have
 * chased, this changes on its own the moment the camera moves, so you can just
 * pick the camera up and watch whether the numbers follow.
 *
 * NOT IMPLEMENTED on firmware v1.0.283: GET_GYRO answered nothing to any of the
 * 20 request shapes `shapes 19` tries. Kept because the message is defined in
 * the protocol and a later firmware may well turn it on — but do not expect it
 * to work today.
 *
 * Note what this would NOT be: the camera body's IMU, not the gimbal's motor angles.
 * It tells you which way the camera is pointing, not where the gimbal has driven
 * its axes to. Worth knowing before building anything on top of it.
 *
 * Read-only.
 */
const GYRO_SAMPLE_BYTES = 48; // six little-endian doubles

function decodeGyro(blob) {
  const samples = [];
  for (let at = 0; at + GYRO_SAMPLE_BYTES <= blob.length; at += GYRO_SAMPLE_BYTES) {
    const view = new DataView(blob.buffer, blob.byteOffset + at, GYRO_SAMPLE_BYTES);
    samples.push({
      ax: view.getFloat64(0, true),
      ay: view.getFloat64(8, true),
      az: view.getFloat64(16, true),
      gx: view.getFloat64(24, true),
      gy: view.getFloat64(32, true),
      gz: view.getFloat64(40, true),
    });
  }
  return samples;
}

async function gimbalCommand(intervalMs, count) {
  await withSession(async (session) => {
    const postures = schema.enums["insta360.messages.Options.CameraPostureType"] ?? {};
    console.log(`reading attitude from ${HOST} every ${intervalMs}ms. Ctrl-C to stop.`);
    console.log("Move the camera and watch whether the numbers follow.\n");

    let warned = false;
    for (;;) {
      const frame = await session.send(19, fieldVarint(1, count), 2500);
      const postureFrame = await session.send(CODE.GET_OPTIONS, fieldVarint(1, 93), 2500);

      const posture = postureFrame?.body?.length
        ? [...valueFields(postureFrame.body)].map(([, v]) => postures[String(v)] ?? v).join(" ")
        : "—";

      if (!frame?.body?.length) {
        if (!warned) {
          console.log("GET_GYRO answered nothing. Try `shapes 19` to find the request form.");
          warned = true;
        }
      } else {
        // Field 1 of GetGyroResp is the sample blob
        const blob = decodeRaw(frame.body).find((r) => r.field === 1 && r.wire === 2)?.value;
        const samples = blob ? decodeGyro(blob) : [];
        const last = samples.at(-1);
        if (!last) {
          console.log(
            `posture ${posture}  |  ${frame.body.length}B, no whole sample: ${frame.body.toString("hex").slice(0, 80)}`,
          );
        } else {
          const n = (value) => value.toFixed(3).padStart(9);
          console.log(
            `posture ${String(posture).padEnd(26)} accel ${n(last.ax)} ${n(last.ay)} ${n(last.az)}` +
              `   gyro ${n(last.gx)} ${n(last.gy)} ${n(last.gz)}   (${samples.length} sample/s)`,
          );
        }
      }
      await new Promise((done) => setTimeout(done, intervalMs));
    }
  });
}

async function calibrateCommand(max, only, skip) {
  // Resolve the group list BEFORE opening a connection, so a typo fails
  // instantly instead of after a network timeout.
  const groups = selectGroups(only, skip);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await withSession(async (session) => {
    console.log("CALIBRATION — every colour mode, filter and strength in one pass.");
    console.log("Read-only. Set each setting on the camera when prompted.\n");
    console.log("Before starting: Color Mode = Standard, resolution 4K30 or lower,");
    console.log("normal Video mode. Filters are unavailable above 4K60.\n");

    console.log(`groups: ${groups.map((g) => g.key).join(", ")}\n`);

    const results = {};
    for (const group of groups) {
      console.log(`\n${"=".repeat(72)}\n${group.heading}\n${"=".repeat(72)}`);
      const observed = {};
      for (const step of group.steps) {
        await waitForCamera(step.prompt);
        const snapshot = await collect(session, { all: true, max });
        // Match on the field NUMBER, never on "number:name". The probe names
        // fields from the raw extraction, where a field this firmware added
        // (filter intensity, say) comes back as "104:UNNAMED" — so looking it
        // up by its corrected name silently misses and the fallback below turns
        // that miss into a confident reading of 0.
        const prefix = group.scope === "device" ? "device." : "FUNCTION_MODE_NORMAL_VIDEO.";
        const entry = Object.entries(flatten(snapshot)).find(
          ([key]) =>
            key.startsWith(prefix) &&
            key.slice(prefix.length).split(":")[0] === String(group.field),
        );
        const raw = entry?.[1];
        // A field sitting at its proto3 default is omitted rather than sent, and
        // for these fields 0 is a real value (Original / no filter), so absence
        // means zero rather than "unknown".
        observed[step.name] = raw ?? 0;
        console.log(`  ${step.name.padEnd(24)} = ${observed[step.name]}`);
      }
      results[group.enumName] = observed;
    }

    fs.writeFileSync(path.join(OUT_DIR, "calibration.json"), JSON.stringify(results, null, 2));

    console.log(
      `\n${"=".repeat(72)}\nPASTE INTO ENUM_OVERRIDES IN scripts/build-schema.mjs\n${"=".repeat(72)}\n`,
    );
    for (const [enumName, observed] of Object.entries(results)) {
      const byNumber = Object.entries(observed)
        .map(([name, value]) => [Number(value), name])
        .sort((a, b) => a[0] - b[0]);
      console.log(`  "${enumName}": {`);
      for (const [value, name] of byNumber) console.log(`    ${value}: "${name}",`);
      console.log("  },");
    }

    const collisions = Object.entries(results).flatMap(([enumName, observed]) => {
      const seen = new Map();
      const clashes = [];
      for (const [name, value] of Object.entries(observed)) {
        if (seen.has(value))
          clashes.push(`${enumName}: ${seen.get(value)} and ${name} both = ${value}`);
        seen.set(value, name);
      }
      return clashes;
    });
    if (collisions.length > 0) {
      console.log(`\n${"!".repeat(72)}`);
      console.log("TWO SETTINGS READ THE SAME NUMBER. The camera almost certainly did");
      console.log("not change between those steps — re-run rather than trusting this:");
      for (const clash of collisions) console.log(`  ${clash}`);
      console.log("!".repeat(72));
    }
    console.log(`\nwritten to ${path.join(OUT_DIR, "calibration.json")}`);
  });
}

async function watchCommand(all, max) {
  await withSession(async (session) => {
    console.log(`watching ${HOST} — change the setting now, Ctrl-C to stop\n`);
    let previous = flatten(await collect(session, { all, max }));
    console.log("baseline captured\n");
    for (;;) {
      await new Promise((done) => setTimeout(done, 1000));
      const next = flatten(await collect(session, { all, max }));
      for (const key of Object.keys(next)) {
        if (String(previous[key]) !== String(next[key])) {
          console.log(`  ${key.padEnd(46)} ${previous[key]}  ->  ${next[key]}`);
        }
      }
      previous = next;
    }
  });
}

const ALL = args.includes("--all");
const MAX = Number(flag("max", "200"));

if (command === "diff") {
  diffCommand(args[1], args[2]);
} else if (command === "pair") {
  const [, before, after] = args;
  if (!before || !after || before.startsWith("--") || after.startsWith("--")) {
    console.error("usage: node scripts/probe-colorspace.mjs pair <before> <after> [--all]");
    process.exit(1);
  }
  await pairCommand(before, after, ALL, MAX);
} else if (command === "calibrate") {
  await calibrateCommand(MAX, flag("only", ""), flag("skip", ""));
} else if (command === "series") {
  const labels = args.slice(1).filter((a) => !a.startsWith("--"));
  if (labels.length < 2) {
    console.error("usage: node scripts/probe-colorspace.mjs series <label> <label> [...] [--all]");
    process.exit(1);
  }
  await seriesCommand(labels, ALL, MAX);
} else if (command === "shapes") {
  const code = Number(args[1]);
  if (!Number.isInteger(code)) {
    console.error("usage: node scripts/probe-colorspace.mjs shapes <command-code>");
    process.exit(1);
  }
  await shapesCommand(code);
} else if (command === "gimbal") {
  await gimbalCommand(Number(flag("interval", "300")), Number(flag("count", "1")));
} else if (command === "monitor") {
  await monitorCommand(MAX, Number(flag("interval", "700")));
} else if (command === "listen") {
  await listenCommand();
} else if (command === "scan") {
  await scanCommand(MAX);
} else if (command === "watch") {
  await watchCommand(ALL, MAX);
} else if (command === "snapshot") {
  const label = args[1];
  if (!label || label.startsWith("--")) {
    console.error("usage: node scripts/probe-colorspace.mjs snapshot <label> [--all]");
    process.exit(1);
  }
  await snapshotCommand(label, ALL, MAX);
} else {
  console.error(
    `unknown command "${command}" — expected calibrate, gimbal, monitor, pair, series, snapshot, diff, watch, scan, listen or shapes`,
  );
  process.exit(1);
}
