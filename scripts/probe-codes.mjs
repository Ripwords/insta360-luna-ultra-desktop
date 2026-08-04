#!/usr/bin/env node
// Message-code discovery via the camera's own error codes.
//
//   node scripts/probe-codes.mjs calibrate            # do this first
//   node scripts/probe-codes.mjs scan phone
//   node scripts/probe-codes.mjs scan request
//   node scripts/probe-codes.mjs listen               # passive, for the gimbal
//   node scripts/probe-codes.mjs shape <code> --execute-ok
//
// `Error.ErrorCode` in the vendored schema distinguishes UNKNOWN_MSG_CODE (1)
// from UNKNOWN_MSG_PAYLOAD (2). That difference is an oracle: send an EMPTY
// body to an unknown code and a reply of "bad payload" means the command
// exists AND refused to run. That is what makes scanning unnamed codes
// defensible where firing a guessed body at them would not be — a command that
// rejects its payload never executed.
//
// The whole thing rests on the camera actually answering unknown codes. It may
// not: this protocol's documented failure mode is silence. `calibrate` settles
// that in about ten seconds, and everything else refuses to run until it has.
//
// Writes ./probe-out/codes-<subcommand>.json

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CODE, fieldVarint, LunaSession } from "./lib/ucd2.mjs";
import { decodeRaw } from "./lib/protobuf.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(fs.readFileSync(path.join(here, "luna-protocol-schema.json"), "utf8"));
const CODES = schema.enums["insta360.messages.MessageCode"] ?? {};
const ERROR_CODES = schema.enums["insta360.messages.Error.ErrorCode"] ?? {};

const args = process.argv.slice(2);
const sub = args.find((a) => !a.startsWith("--")) ?? "help";
const positional = args.filter((a) => !a.startsWith("--")).slice(1);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const HOST = flag("host", "192.168.42.1");
const PORT = Number(flag("port", "6666"));
const TIMEOUT = Number(flag("timeout", "700"));
const GAP = Number(flag("gap", "40"));
const OUT_DIR = path.resolve("probe-out");

const nameOf = (code) => CODES[String(code)] ?? null;

/**
 * Codes a sweep must never touch, by number rather than by name, because the
 * point of a sweep is the codes we cannot name. An empty body is no defence
 * here: a command that takes no arguments will simply run.
 *
 * The 12288+ factory block is excluded wholesale — it contains
 * VIGNETTE/BLC/BPC_DATA_SAVE and SET_AAA_FACTORYMODE, which overwrite factory
 * calibration. Reaching a factory command at all requires naming it explicitly
 * on the command line with --allow-factory.
 */
const NEVER_SWEEP = new Set([
  6, // CANCEL_CAPTURE
  12, // DELETE_FILES
  24, // ERASE_SD_CARD
  32, // REBOOT_CAMERA
  33,
  34, // OPEN/CLOSE_CAMERA_WIFI
  40, // CANCEL_AUTHORIZATION
  56, // SET_STANDBY_MODE
  57, // RESTORE_FACTORY_SETTINGS
  85, // SET_WIFI_SEIZE_ENABLE
  112, // SET_WIFI_CONNECTION_INFO
  118, // SET_ACCESS_CAMERA_FILE_STATE
]);

const isFactory = (code) => code >= 12288;

/** Unnamed numbers in [from, to] — the gaps a 2020 extraction left behind. */
function unnamedRange(from, to) {
  const out = [];
  for (let code = from; code <= to; code++) {
    if (nameOf(code)) continue;
    if (NEVER_SWEEP.has(code) || isFactory(code)) continue;
    out.push(code);
  }
  return out;
}

const PRESETS = {
  // Interior gaps in the phone-command block: 20-21, 44-47, 69-70, 72-82,
  // 88-102, 106-111, 114-117, 119, 121-150. Post-2020 additions land here.
  phone: () => unnamedRange(0, 152),
  // PHONE_REQUEST_BEGIN names this block and the extraction defines nothing in
  // it. An interactive pan/tilt request is exactly what a "request" block is
  // for, which makes this the highest-value range on the camera.
  request: () => unnamedRange(4096, 8191),
  // Everything between the phone block and the request block.
  high: () => unnamedRange(153, 4095),
};

const say = (...parts) => console.log(parts.join(" "));

const writeOut = (name, data) => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `codes-${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  say(`\nwrote ${file}`);
};

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Reduce a reply to something comparable. Signatures are learned from
 * calibrate's known-good and known-bad cases rather than assumed, because
 * nothing documents how this camera reports an error — it may answer on the
 * same code with an Error body, on a different code, or not at all.
 *
 * A signature describes the SHAPE of the reply, never the code number in it.
 * The camera echoes the code it was asked about, so folding that number in
 * would make every reply unique and every comparison come out "different".
 * Whether the echo matched is still worth recording, so it goes in as a flag.
 */
function classify(frame, requested) {
  if (!frame) return { kind: "silent", signature: "silent" };
  const echo = frame.code === requested ? "echo" : `code${frame.code}`;
  const body = frame.body ?? Buffer.alloc(0);
  if (body.length === 0) return { kind: "empty", signature: `empty/${echo}` };

  const records = decodeRaw(body);
  const hex = body.toString("hex");

  // An Error is { code: enum, message: string } — one small varint in field 1,
  // optionally a string in field 2, and nothing else.
  const looksLikeError =
    records.length > 0 &&
    records.length <= 2 &&
    records[0].field === 1 &&
    records[0].wire === 0 &&
    records[0].value <= 5 &&
    (records.length === 1 || (records[1].field === 2 && records[1].wire === 2));

  if (looksLikeError) {
    const value = Number(records[0].value);
    const message = records[1] ? Buffer.from(records[1].value).toString("utf8") : null;
    return {
      kind: "error",
      error: value,
      errorName: ERROR_CODES[String(value)] ?? `#${value}`,
      message,
      signature: `error:${value}/${echo}`,
      hex,
    };
  }
  return { kind: "data", bytes: body.length, signature: `data/${echo}`, hex };
}

async function open() {
  const session = new LunaSession(HOST, PORT);
  await session.connect();
  await sleep(1500);
  return session;
}

/**
 * Establish what an unknown code and a bad payload actually look like, and
 * refuse to bless the oracle unless the two are distinguishable.
 */
async function calibrate() {
  say(`oracle calibration against ${HOST}\n`);
  const session = await open();

  const cases = [
    {
      label: "known-good code, valid body (GET_OPTIONS)",
      code: CODE.GET_OPTIONS,
      body: fieldVarint(1, 1),
      expect: "a real answer",
    },
    {
      label: "known-good code, junk body (GET_OPTIONS)",
      code: CODE.GET_OPTIONS,
      body: Buffer.from("ffffffffffffffff", "hex"),
      expect: "UNKNOWN_MSG_PAYLOAD, if payloads are validated at all",
    },
    {
      label: "known-good code, empty body (GET_OPTIONS)",
      code: CODE.GET_OPTIONS,
      body: Buffer.alloc(0),
      expect: "the empty-body baseline for a code that DOES exist",
    },
    {
      label: "surely-absent code 3000, empty body",
      code: 3000,
      body: Buffer.alloc(0),
      expect: "UNKNOWN_MSG_CODE",
    },
    {
      label: "surely-absent code 3001, empty body",
      code: 3001,
      body: Buffer.alloc(0),
      expect: "UNKNOWN_MSG_CODE, matching 3000",
    },
  ];

  const observed = [];
  for (const probe of cases) {
    const frame = await session.send(probe.code, probe.body, 3000);
    const result = classify(frame, probe.code);
    observed.push({ ...probe, body: probe.body.toString("hex"), result });
    say(`  ${probe.label}`);
    say(`    expected: ${probe.expect}`);
    say(
      `    got:      ${result.kind}` +
        (result.errorName ? ` ${result.errorName}` : "") +
        (result.message ? ` "${result.message}"` : "") +
        (result.hex ? ` [${result.hex.slice(0, 64)}]` : ""),
    );
    say("");
    await sleep(200);
  }
  session.close();

  const absent = observed[3].result.signature;
  const absentAgain = observed[4].result.signature;
  const badPayload = observed[1].result.signature;
  const emptyOnReal = observed[2].result.signature;

  say("=".repeat(72));
  const stable = absent === absentAgain;
  const distinguishable = stable && absent !== badPayload && absent !== emptyOnReal;

  if (!stable) {
    say("ORACLE UNUSABLE — two absent codes answered differently.");
    say("The reply is not a function of the code, so it cannot identify one.");
  } else if (observed[3].result.kind === "silent") {
    say("ORACLE UNUSABLE — the camera does not answer unknown codes at all.");
    say("Silence is what a firewalled code and a nonexistent one both look");
    say("like. Scanning would produce 4000 timeouts and no information.");
    say("\nFall back to static extraction (APK/firmware) or the BLE link.");
  } else if (!distinguishable) {
    say("ORACLE UNUSABLE — an absent code answers the same as a present one.");
    say(`  absent:            ${absent}`);
    say(`  bad payload:       ${badPayload}`);
    say(`  empty on a real code: ${emptyOnReal}`);
    say("\nNothing here separates 'no such command' from 'bad arguments'.");
  } else {
    say("ORACLE USABLE.");
    say(`  absent code  -> ${absent}`);
    say(`  bad payload  -> ${badPayload}`);
    say(`  empty body on a code that exists -> ${emptyOnReal}`);
    say("\nA scanned code whose reply differs from the absent-code signature");
    say("is a command this firmware has and the extraction does not name.");
    say("\nNext:  node scripts/probe-codes.mjs scan request");
  }

  writeOut("calibrate", {
    host: HOST,
    absent,
    badPayload,
    emptyOnReal,
    usable: distinguishable,
    observed,
  });
  return distinguishable ? { absent, badPayload, emptyOnReal } : null;
}

async function scan() {
  const preset = positional[0];
  const explicit = flag("codes", null);

  let codes;
  if (explicit) {
    codes = explicit.split(",").map(Number).filter(Number.isInteger);
    const factory = codes.filter(isFactory);
    if (factory.length > 0 && !has("allow-factory")) {
      say(`refusing factory codes ${factory.join(", ")} without --allow-factory.`);
      say("That block writes lens calibration. Read the warning in the docs first.");
      return;
    }
  } else if (PRESETS[preset]) {
    codes = PRESETS[preset]();
  } else {
    say(`unknown preset "${preset}". Available: ${Object.keys(PRESETS).join(", ")}`);
    say("Or pass --codes 4100,4101,4102");
    return;
  }

  say(`calibrating the oracle before scanning ${codes.length} codes\n`);
  const baseline = await calibrate();
  if (!baseline) {
    say("\nnot scanning: the oracle cannot tell an absent code from a present one.");
    return;
  }

  say(`\n${"=".repeat(72)}`);
  say(`scanning ${codes.length} unnamed codes with an EMPTY body`);
  say(`${(codes.length * (GAP + TIMEOUT / 4)) / 1000 / 60} minutes, roughly, if most are silent`);
  say("=".repeat(72) + "\n");

  const session = await open();
  const hits = [];
  let done = 0;

  for (const code of codes) {
    const frame = await session.send(code, Buffer.alloc(0), TIMEOUT);
    const result = classify(frame, code);
    done++;

    if (result.signature !== baseline.absent) {
      hits.push({ code, ...result });
      say(
        `  ${code} (0x${code.toString(16)}) -> ${result.kind}` +
          (result.errorName ? ` ${result.errorName}` : "") +
          (result.message ? ` "${result.message}"` : "") +
          (result.hex ? ` [${result.hex.slice(0, 48)}]` : ""),
      );
    }
    if (done % 250 === 0) say(`  ... ${done}/${codes.length}, ${hits.length} hits`);
    await sleep(GAP);
  }
  session.close();

  say(`\n${"=".repeat(72)}`);
  say(`${hits.length} of ${codes.length} codes answered differently from an absent one.`);
  const payloadHits = hits.filter(
    (h) => h.kind === "error" && h.errorName === "UNKNOWN_MSG_PAYLOAD",
  );
  if (payloadHits.length > 0) {
    say(`\n${payloadHits.length} rejected the empty body — these EXIST and take arguments:`);
    say("  " + payloadHits.map((h) => h.code).join(", "));
    say("\nNext:  node scripts/probe-codes.mjs shape <code>");
  }
  const dataHits = hits.filter((h) => h.kind === "data");
  if (dataHits.length > 0) {
    say(`\n${dataHits.length} answered with data to an empty body — these RAN:`);
    say("  " + dataHits.map((h) => `${h.code} (${h.bytes}B)`).join(", "));
  }

  writeOut(`scan-${explicit ? "explicit" : preset}`, {
    host: HOST,
    baseline,
    scanned: codes.length,
    hits,
  });
}

/**
 * Walk one code's payload shape. Every probe that is NOT rejected is a probe
 * the camera accepted and acted on, so this needs eyes on the camera and an
 * explicit --execute-ok.
 */
async function shape() {
  const code = Number(positional[0]);
  if (!Number.isInteger(code)) {
    say("usage: node scripts/probe-codes.mjs shape <code> --execute-ok");
    return;
  }
  if (!has("execute-ok")) {
    say(`Shape-probing ${code} sends bodies the camera may ACCEPT AND RUN.`);
    say("Unlike `scan`, this is not read-only. Watch the camera while it runs,");
    say("then re-run with --execute-ok.");
    return;
  }
  if (isFactory(code) && !has("allow-factory")) {
    say("refusing a factory code without --allow-factory.");
    return;
  }

  const baseline = await calibrate();
  if (!baseline) return;

  // One field at a time, smallest plausible values. A gimbal command is most
  // likely small varints (axis, direction, speed) or a nested message.
  const probes = [{ label: "empty", body: Buffer.alloc(0) }];
  for (let field = 1; field <= 6; field++) {
    for (const value of [0, 1]) {
      probes.push({ label: `field ${field} = ${value} (varint)`, body: fieldVarint(field, value) });
    }
    probes.push({
      label: `field ${field} = {} (nested)`,
      body: Buffer.concat([Buffer.from([(field << 3) | 2]), Buffer.from([0])]),
    });
  }

  say(`\n${"=".repeat(72)}`);
  say(`shape probe on code ${code} — ${probes.length} bodies`);
  say("=".repeat(72) + "\n");

  const session = await open();
  const results = [];
  for (const probe of probes) {
    const frame = await session.send(code, probe.body, 3000);
    const result = classify(frame, code);
    const rejected = result.kind === "error";
    results.push({ ...probe, body: probe.body.toString("hex"), result });
    say(
      `  ${probe.label.padEnd(28)} -> ${rejected ? "rejected" : "ACCEPTED"} ` +
        `${result.kind}${result.errorName ? ` ${result.errorName}` : ""}` +
        (result.hex ? ` [${result.hex.slice(0, 48)}]` : ""),
    );
    await sleep(300);
  }
  session.close();

  say("\nA body the camera stopped rejecting is a field this message has.");
  say("Anything marked ACCEPTED ran — check the camera before reading further.");
  writeOut(`shape-${code}`, { host: HOST, code, baseline, results });
}

/**
 * Sit on the control channel and print every frame the camera sends unasked.
 *
 * Move the gimbal by hand, or drive it from the camera's own screen, and watch
 * for a notification that tracks the motion. The notification block has as many
 * unnamed numbers as the command block (8218, 8221, 8223-8231, 8235-8247,
 * 8251+) and costs nothing to watch. Purely passive: sends only the keepalive.
 */
async function listen() {
  const seconds = Number(flag("seconds", "120"));
  say(`listening for ${seconds}s on ${HOST} — move the gimbal now\n`);

  const session = await open();
  const seen = new Map();
  const lastHex = new Map();
  const log = [];

  session.onUnsolicited = (frame) => {
    const at = new Date().toISOString().slice(11, 23);

    // Only command-response frames carry a code and a body. Everything else —
    // the stream and media types the camera pushes on its own cadence — comes
    // through as { type, payload }, and reading `.body` on those silently
    // reports every one of them as empty.
    const isCommand = frame.code !== undefined;
    const bytes = (isCommand ? frame.body : frame.payload) ?? Buffer.alloc(0);
    const key = isCommand ? frame.code : `type${frame.type}`;
    const name = isCommand
      ? (nameOf(frame.code) ?? `UNNAMED_${frame.code}`)
      : `STREAM_TYPE_${frame.type}`;

    seen.set(key, (seen.get(key) ?? 0) + 1);
    const hex = bytes.toString("hex");
    const entry = {
      at,
      key,
      name,
      bytes: bytes.length,
      hex,
      records: isCommand
        ? decodeRaw(bytes).map((r) => ({
            field: r.field,
            wire: r.wire,
            value:
              typeof r.value === "bigint" || typeof r.value === "number"
                ? String(r.value)
                : Buffer.from(r.value).toString("hex"),
          }))
        : [],
    };
    log.push(entry);

    // A heartbeat that repeats the same bytes says nothing and drowns out what
    // does. Print a stream frame only when its contents change — that change is
    // the whole signal we are listening for.
    const changed = lastHex.get(key) !== hex;
    lastHex.set(key, hex);
    if (isCommand || changed) {
      say(
        `  ${at}  ${String(key).padEnd(14)}  ${name.padEnd(34)}  ${String(bytes.length).padStart(4)}B  ${hex.slice(0, 64)}` +
          (isCommand || changed === false ? "" : "   <- CHANGED"),
      );
    }
  };

  await sleep(seconds * 1000);
  session.close();

  say(`\n${"=".repeat(72)}`);
  say(`${log.length} unsolicited frames, ${seen.size} distinct sources`);
  for (const [key, count] of [...seen].sort((a, b) => b[1] - a[1])) {
    const distinct = new Set(log.filter((e) => e.key === key).map((e) => e.hex)).size;
    const label =
      typeof key === "number" ? (nameOf(key) ?? "UNNAMED — not in the schema") : "stream frame";
    say(
      `  ${String(key).padStart(14)}  ${count.toString().padStart(5)}x  ` +
        `${String(distinct).padStart(4)} distinct payloads  ${label}`,
    );
  }
  say("\nA source with many distinct payloads is carrying changing numbers.");
  say("One that repeats a single payload is a heartbeat.");
  say("\nA code that fires in step with the gimbal and carries changing numbers");
  say("is attitude. One that fires once per movement is a state change.");
  writeOut("listen", { host: HOST, seconds, counts: Object.fromEntries(seen), log });
}

const HELP = `
Message-code discovery for the Luna Ultra control protocol.

  calibrate                 Check whether the error-code oracle works here.
                            Everything else runs this first and stops if it
                            does not.

  scan <preset>             Sweep unnamed codes with an EMPTY body.
    phone                   gaps inside 0-152
    request                 4096-8191, the unpopulated PHONE_REQUEST block
    high                    153-4095
    --codes 4100,4101       explicit list instead of a preset

  shape <code>              Walk one code's payload field by field.
                            Not read-only; needs --execute-ok.

  listen                    Print unsolicited frames while you move the gimbal.
                            --seconds 120

Flags: --host 192.168.42.1  --port 6666  --timeout 700  --gap 40
`;

const main = { calibrate, scan, shape, listen }[sub];
if (!main) {
  say(HELP);
} else {
  main().catch((error) => {
    say(`\nfailed: ${error.message}`);
    process.exitCode = 1;
  });
}
