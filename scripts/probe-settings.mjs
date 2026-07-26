#!/usr/bin/env node
// Read-only settings probe. Asks the camera what it currently supports and
// decodes the answers against the vendored protobuf schemas, so we can build
// the pro-camera UI against verified fields instead of assumptions.
//
//   node scripts/probe-settings.mjs [--host 192.168.42.1]
//
// Sends only GET_* commands. It never changes a setting, starts a capture or
// touches storage.
//
// Writes ./probe-out/settings-report.txt and ./probe-out/settings-raw.json

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CODE, fieldVarint, LunaSession } from "./lib/ucd2.mjs";
import { annotate, decodeRaw, renderRows } from "./lib/protobuf.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(fs.readFileSync(path.join(here, "luna-protocol-schema.json"), "utf8"));

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const HOST = flag("host", "192.168.42.1");
const PORT = Number(flag("port", "6666"));
const OUT_DIR = path.resolve("probe-out");

/** Asking for everything at once risks one bad option killing a whole reply. */
const BATCH = 12;

const lines = [];
const say = (...parts) => {
  const text = parts.join(" ");
  lines.push(text);
  console.log(text);
};

const OPTION_TYPE = "insta360.messages.OptionType";
const PHOTOGRAPHY_OPTION_TYPE = "insta360.messages.PhotographyOptionType";
const FUNCTION_MODE = "insta360.messages.FunctionMode";

const numbersOf = (enumName) =>
  Object.keys(schema.enums[enumName] ?? {})
    .map(Number)
    .filter((n) => n > 0)
    .sort((a, b) => a - b);

const nameOf = (enumName, value) => schema.enums[enumName]?.[String(value)] ?? `#${value}`;
const valueOf = (enumName, name) =>
  Number(Object.entries(schema.enums[enumName] ?? {}).find(([, n]) => n === name)?.[0] ?? -1);

const chunk = (items, size) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, i * size + size),
  );

/**
 * Query one batch of option types. Returns the decoded rows plus which of the
 * requested types the camera actually echoed back — the echo is how we learn
 * what it supports.
 */
async function query(session, { code, body, respMessage, label }) {
  const frame = await session.send(code, body);
  if (!frame) return { ok: false, reason: "timed out" };
  if (!frame.body || frame.body.length === 0) return { ok: false, reason: "empty response" };
  return {
    ok: true,
    label,
    raw: frame.body.toString("hex"),
    rows: annotate(frame.body, respMessage, schema),
    records: decodeRaw(frame.body),
  };
}

async function probeGroup(
  session,
  { title, code, respMessage, enumName, types, extra = Buffer.alloc(0) },
) {
  say(`\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}`);

  const supported = new Set();
  const settings = new Map();
  let failures = 0;

  for (const batch of chunk(types, BATCH)) {
    const body = Buffer.concat([...batch.map((t) => fieldVarint(1, t)), extra]);
    const result = await query(session, { code, body, respMessage, label: batch.join(",") });
    if (!result.ok) {
      failures++;
      say(`  batch ${batch.map((t) => nameOf(enumName, t)).join(", ")}\n    -> ${result.reason}`);
      continue;
    }
    // Field 1 echoes the option types the camera recognised
    for (const record of result.records) {
      if (record.field === 1 && record.wire === 0) supported.add(record.value);
    }
    for (const row of result.rows) {
      if (row.name && row.name !== "?" && row.name !== "option_types") {
        settings.set(`${row.depth}:${row.field}:${row.name}`, row);
      }
    }
  }

  const asked = types.length;
  say(
    `\nasked for ${asked} option types in ${Math.ceil(asked / BATCH)} batches` +
      (failures ? `, ${failures} batch(es) failed` : ", all batches answered"),
  );
  say(`camera acknowledged ${supported.size} of them\n`);

  const unsupported = types.filter((t) => !supported.has(t));
  if (supported.size > 0) {
    say("SUPPORTED:");
    say(
      "  " +
        [...supported]
          .sort((a, b) => a - b)
          .map((t) => nameOf(enumName, t))
          .join("\n  "),
    );
  }
  if (unsupported.length > 0) {
    say("\nNOT ACKNOWLEDGED:");
    say("  " + unsupported.map((t) => nameOf(enumName, t)).join("\n  "));
  }

  if (settings.size > 0) {
    say("\nCURRENT VALUES:");
    say(renderRows([...settings.values()]));
  }
  return { supported, settings };
}

async function main() {
  say(`settings probe against ${HOST}`);
  say(
    `schema: ${Object.keys(schema.messages).length} messages, ${Object.keys(schema.enums).length} enums`,
  );
  say("read-only: only GET_OPTIONS and GET_PHOTOGRAPHY_OPTIONS are sent\n");

  const session = new LunaSession(HOST, PORT);
  try {
    await session.connect();
  } catch (error) {
    say(`cannot reach the camera: ${error.message}`);
    return;
  }
  say(`connected to ${HOST}:6666`);
  await new Promise((done) => setTimeout(done, 1500));

  const results = {};

  results.options = await probeGroup(session, {
    title: "1. GET_OPTIONS  —  device state, wifi, storage, sub-modes",
    code: CODE.GET_OPTIONS,
    respMessage: "insta360.messages.GetOptionsResp",
    enumName: OPTION_TYPE,
    types: numbersOf(OPTION_TYPE),
  });

  // Photography options are per function mode, so ask video and photo apart
  for (const modeName of ["FUNCTION_MODE_NORMAL_VIDEO", "FUNCTION_MODE_NORMAL_IMAGE"]) {
    const mode = valueOf(FUNCTION_MODE, modeName);
    if (mode < 0) continue;
    results[modeName] = await probeGroup(session, {
      title: `2. GET_PHOTOGRAPHY_OPTIONS  —  ${modeName}`,
      code: CODE.GET_PHOTOGRAPHY_OPTIONS,
      respMessage: "insta360.messages.GetPhotographyOptionsResp",
      enumName: PHOTOGRAPHY_OPTION_TYPE,
      types: numbersOf(PHOTOGRAPHY_OPTION_TYPE),
      extra: fieldVarint(2, mode),
    });
  }

  // The gimbal is the whole reason this camera is interesting, and PTZ_CTRL
  // is an option type the 2020 Options message has no field for. Ask for the
  // gimbal-adjacent types one at a time so nothing hides behind a bad batch.
  say(
    `\n${"=".repeat(72)}\n3. GIMBAL / PTZ  —  individually, unknown fields are the point\n${"=".repeat(72)}`,
  );
  const spotlight = [
    "PTZ_CTRL",
    "CAMERA_POSTURE",
    "CALIBRATION_ORIENTATION",
    "OFFSET_STATES",
    "WINDOW_CROP_INFO",
  ];
  const ptz = {};
  for (const name of spotlight) {
    const type = valueOf(OPTION_TYPE, name);
    if (type < 0) {
      say(`\n  ${name}: not in the schema's enum`);
      continue;
    }
    const frame = await session.send(CODE.GET_OPTIONS, fieldVarint(1, type));
    if (!frame) {
      say(`\n  ${name} (type ${type}): timed out`);
      continue;
    }
    if (!frame.body?.length) {
      say(`\n  ${name} (type ${type}): empty response — camera does not expose it here`);
      continue;
    }
    ptz[name] = frame.body.toString("hex");
    say(`\n  ${name} (type ${type}) -> ${frame.body.length} bytes`);
    say(`    raw: ${frame.body.toString("hex")}`);
    say(renderRows(annotate(frame.body, "insta360.messages.GetOptionsResp", schema)));
  }
  results.ptzRaw = ptz;

  say(`\n${"=".repeat(72)}\nSUMMARY\n${"=".repeat(72)}`);
  for (const [key, value] of Object.entries(results)) {
    if (!value?.supported) continue;
    say(
      `  ${key}: ${value.supported.size} option types acknowledged, ${value.settings.size} values read`,
    );
  }
  say("\nAnything marked 'unknown, wire N' above is a field this camera has and");
  say("the 2020-era schema does not — those are the Luna-Ultra-specific ones.");

  session.close();

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "settings-report.txt"), lines.join("\n"));
  fs.writeFileSync(
    path.join(OUT_DIR, "settings-raw.json"),
    JSON.stringify(
      Object.fromEntries(
        Object.entries(results)
          .filter(([, v]) => v?.supported)
          .map(([k, v]) => [
            k,
            {
              supported: [...v.supported].sort((a, b) => a - b),
              values: [...v.settings.values()].map((r) => ({
                field: r.field,
                name: r.name,
                value: String(r.value),
                note: r.note,
              })),
            },
          ]),
      ),
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(OUT_DIR, "settings-ptz-raw.json"),
    JSON.stringify(results.ptzRaw ?? {}, null, 2),
  );
  say(`\nwrote ${path.join(OUT_DIR, "settings-report.txt")}`);
}

main();
