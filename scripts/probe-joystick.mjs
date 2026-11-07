#!/usr/bin/env node
// Probe: what does the camera report when the joystick button is triple-clicked
// to swing the gimbal round 180 degrees? The schema has
// CAMERA_NOTIFICATION_KEY_PRESSED (8200) with F0_TRIPLE_PRESS, and the 8302
// traffic is the gimbal state. The command the phone app would send for the
// same turn (GIMBAL_CONTROL) has no known code yet, so this records the
// camera's side to find what changes.
//
// Quit the Luna Ultra desktop app first, join the camera's Wi-Fi, then:
//   node scripts/probe-joystick.mjs
//
// Each step is marked in the log, so the triple click can be compared with a
// single and double click. Saved to probe-out/joystick-log.txt.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { LunaSession, fieldVarint } from "./lib/ucd2.mjs";
import { decodeRaw } from "./lib/protobuf.mjs";

const schema = JSON.parse(
  fs.readFileSync(new URL("./luna-protocol-schema.json", import.meta.url), "utf8"),
);
const NAMES = schema.enums["insta360.messages.MessageCode"];
const KEYS = schema.enums["insta360.messages.NotificatoinKeyPressed.KeyId"];
const PRESS_TYPES = schema.enums["insta360.messages.ButtonPressType"];
const PRESS_MODES = schema.enums["insta360.messages.ButtonPressMode"];

const KEY_PRESSED = 8200;
const GET_BUTTON_PRESS_PARAM = 104;
const SET_ACCESS_CAMERA_FILE_STATE = 118;
const LIVE_VIEW = 5;

const LOG = path.resolve("probe-out", "joystick-log.txt");
fs.mkdirSync(path.dirname(LOG), { recursive: true });
const log = [];
const t0 = Date.now();
const record = (line) => {
  const stamped = `${((Date.now() - t0) / 1000).toFixed(2).padStart(7)}s ${line}`;
  log.push(stamped);
  console.log(stamped);
};

function render(body, depth = 0) {
  let rows;
  try {
    rows = decodeRaw(body);
  } catch {
    return `<${body.length}B ${body.toString("hex")}>`;
  }
  return rows
    .map((row) =>
      Buffer.isBuffer(row.value)
        ? depth < 2
          ? `${row.field}={${render(row.value, depth + 1)}}`
          : `${row.field}=<${row.value.toString("hex")}>`
        : `${row.field}=${row.value}`,
    )
    .join(" ");
}

function describe(frame) {
  if (frame.code === undefined) return null;
  let text = `code ${frame.code} ${NAMES[String(frame.code)] ?? "(unnamed)"}  ${render(frame.body)}`;
  if (frame.code === KEY_PRESSED) {
    const key = decodeRaw(frame.body).find((row) => row.field === 1)?.value ?? 0;
    text += `  -> ${KEYS[String(key)] ?? key}`;
  }
  return text;
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const session = new LunaSession("192.168.42.1");
session.onUnsolicited = (frame) => {
  const text = describe(frame);
  if (text) record(`camera says: ${text}`);
};

console.log("Connecting to 192.168.42.1:6666 …");
await session.connect();
record("connected");

// Unfolded and in shooting mode, the way the app leaves it.
const unfold = await session.send(SET_ACCESS_CAMERA_FILE_STATE, fieldVarint(1, LIVE_VIEW), 3000);
record(`LIVE_VIEW announcement: ${unfold ? describe(unfold) : "no reply"}`);

// What the camera says each click count is mapped to.
for (const type of [0, 1, 2, 3]) {
  const reply = await session.send(GET_BUTTON_PRESS_PARAM, fieldVarint(3, type), 3000);
  let mode = "";
  if (reply) {
    const value = decodeRaw(reply.body).find((row) => row.field === 2)?.value;
    if (typeof value === "number") mode = `  -> ${PRESS_MODES[String(value)] ?? value}`;
  }
  record(
    `button mapping for ${PRESS_TYPES[String(type)]}: ${reply ? describe(reply) : "no reply"}${mode}`,
  );
}

const steps = [
  "Leave the camera alone for 5 seconds (baseline), then press Enter.",
  "TRIPLE-click the joystick button so the gimbal turns 180°. Wait for it to stop, then press Enter.",
  "TRIPLE-click again to turn it back. Wait for it to stop, then press Enter.",
  "SINGLE-click the joystick button once, then press Enter.",
  "DOUBLE-click the joystick button, then press Enter.",
  "Push the joystick left and right for a second, then press Enter.",
];
for (const [index, step] of steps.entries()) {
  record(`=== step ${index + 1}: ${step}`);
  await rl.question(`\nStep ${index + 1}. ${step}`);
}
const notes = await rl.question("\nAnything you noticed (what the gimbal did)? ");
record(`user: ${notes.trim()}`);

fs.writeFileSync(LOG, log.join("\n") + "\n");
console.log(`\nSaved ${LOG}`);
rl.close();
session.close();
process.exit(0);
