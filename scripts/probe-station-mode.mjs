#!/usr/bin/env node
// Probe: can the Luna Ultra join your own Wi-Fi network, so the computer stays
// online while it streams? The schema names SET_WIFI_CONNECTION_INFO (112),
// GET_WIFI_CONNECTION_INFO (113) and the CAMERA_NOTIFICATION_WIFI_CONNECTION_RESULT
// (8232) the camera sends back, but nothing has confirmed the Luna acts on them.
//
// Quit the Luna Ultra desktop app first. Two phases:
//
//   1. Join the camera's Wi-Fi, then:   node scripts/probe-station-mode.mjs join
//      Asks for your network's name and password and hands them to the camera
//      only. Logs everything the camera says back, including the address it
//      got on your network.
//
//   2. Join your own Wi-Fi again, then: node scripts/probe-station-mode.mjs reach <camera-ip>
//      Checks the camera answers control commands over your network. If it
//      does, run: node scripts/probe-liveview.mjs --host <camera-ip>
//
// The log (without the password) is saved to
// probe-out/station-mode-log.txt.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { Writable } from "node:stream";
import { LunaSession, fieldVarint, varint } from "./lib/ucd2.mjs";
import { decodeRaw } from "./lib/protobuf.mjs";

const schema = JSON.parse(
  fs.readFileSync(new URL("./luna-protocol-schema.json", import.meta.url), "utf8"),
);
const NAMES = schema.enums["insta360.messages.MessageCode"];

const SET_WIFI_CONNECTION_INFO = 112;
const GET_WIFI_CONNECTION_INFO = 113;
const WIFI_CONNECTION_RESULT = 8232;
const SET_ACCESS_CAMERA_FILE_STATE = 118;
const LIVE_VIEW = 5;
const RESULTS = ["SUCCESS", "TIMEOUT", "ERROR_CONNECT_FAILED"];

const LOG = path.resolve("probe-out", "station-mode-log.txt");
fs.mkdirSync(path.dirname(LOG), { recursive: true });
const log = [];
const t0 = Date.now();
const record = (line) => {
  const stamped = `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s ${line}`;
  log.push(stamped);
  console.log(stamped);
};
const save = () => {
  fs.appendFileSync(LOG, `--- ${new Date().toISOString()} ${process.argv.slice(2).join(" ")}\n`);
  fs.appendFileSync(LOG, log.join("\n") + "\n");
  console.log(`\nLog appended to ${LOG}`);
};

const fieldBytes = (number, bytes) =>
  Buffer.concat([varint((number << 3) | 2), varint(bytes.length), bytes]);
const fieldString = (number, text) => fieldBytes(number, Buffer.from(text, "utf8"));

/** Every field, with nested messages opened one level when they decode cleanly. */
function render(body, depth = 0) {
  let rows;
  try {
    rows = decodeRaw(body);
  } catch {
    return `<${body.length}B>`;
  }
  return rows
    .map((row) => {
      if (!Buffer.isBuffer(row.value)) return `${row.field}=${row.value}`;
      const text = row.value.toString("utf8");
      if (/^[\x20-\x7e]*$/.test(text)) return `${row.field}="${text}"`;
      return depth < 2
        ? `${row.field}={${render(row.value, depth + 1)}}`
        : `${row.field}=<${row.value.length}B>`;
    })
    .join(" ");
}

const describe = (frame) =>
  frame.code === undefined
    ? null
    : `code ${frame.code} ${NAMES[String(frame.code)] ?? "(unnamed)"}  ${render(frame.body)}`;

async function open(host) {
  const session = new LunaSession(host);
  session.onUnsolicited = (frame) => {
    const text = describe(frame);
    if (text) record(`camera says: ${text}`);
  };
  console.log(`Connecting to ${host}:6666 …`);
  await session.connect();
  session.socket.on("close", () => record("control connection closed"));
  session.socket.on("error", (error) => record(`control connection error: ${error.message}`));
  record(`connected to ${host}`);
  return session;
}

async function ask(session, label, code, body = Buffer.alloc(0), timeoutMs = 5000) {
  const reply = await session.send(code, body, timeoutMs);
  record(`${label}: ${reply ? describe(reply) : `no reply within ${timeoutMs / 1000} s`}`);
  return reply;
}

/** A prompt that does not echo what is typed. */
async function secret(question) {
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) process.stdout.write(chunk);
      done();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
  const answer = rl.question(question);
  muted = true;
  const value = await answer;
  rl.close();
  process.stdout.write("\n");
  return value;
}

async function join() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const session = await open("192.168.42.1");
  await ask(session, "current Wi-Fi connection info", GET_WIFI_CONNECTION_INFO);

  const ssid = (await rl.question("\nYour Wi-Fi network's name (SSID): ")).trim();
  rl.close();
  const password = await secret("Its password (not shown, sent to the camera only): ");
  record(`sending SET_WIFI_CONNECTION_INFO for "${ssid}" (password ${password.length} chars)`);

  const settled = new Promise((resolve) => {
    const previous = session.onUnsolicited;
    session.onUnsolicited = (frame) => {
      previous(frame);
      if (frame.code === WIFI_CONNECTION_RESULT) resolve(frame);
    };
    session.socket.once("close", () => resolve(null));
    setTimeout(() => resolve(undefined), 60_000);
  });
  const info = Buffer.concat([fieldString(1, ssid), fieldString(3, password)]);
  await ask(session, "SET reply", SET_WIFI_CONNECTION_INFO, fieldBytes(1, info), 10_000);

  record("waiting up to 60 s for the camera to report the result …");
  const result = await settled;
  if (result === undefined) record("no WIFI_CONNECTION_RESULT within 60 s");
  else if (result === null)
    record("the camera dropped this connection (it may have left its own Wi-Fi)");
  else {
    const rows = decodeRaw(result.body);
    const code = rows.find((row) => row.field === 1)?.value ?? 0;
    record(`result: ${RESULTS[code] ?? code}`);
  }
  if (result !== null) await ask(session, "Wi-Fi connection info now", GET_WIFI_CONNECTION_INFO);

  console.log(
    "\nIf the camera reported an address (an ip like 192.168.x.y), join your own Wi-Fi\n" +
      "and run:  node scripts/probe-station-mode.mjs reach <that-ip>\n" +
      "If it didn't, check your router's list of connected devices for the camera.",
  );
  session.close();
}

async function reach(host) {
  const session = await open(host);
  await ask(session, "Wi-Fi connection info", GET_WIFI_CONNECTION_INFO);
  await ask(
    session,
    "LIVE_VIEW announcement",
    SET_ACCESS_CAMERA_FILE_STATE,
    fieldVarint(1, LIVE_VIEW),
  );
  console.log(
    `\nControl works over your network if both lines above show a reply.\n` +
      `Next, check video:  node scripts/probe-liveview.mjs --host ${host}`,
  );
  session.close();
}

const [phase, host] = process.argv.slice(2);
try {
  if (phase === "join") await join();
  else if (phase === "reach" && host) await reach(host);
  else {
    console.log("Usage: probe-station-mode.mjs join | reach <camera-ip>");
    process.exit(2);
  }
} catch (error) {
  record(`failed: ${error.message}`);
} finally {
  save();
  process.exit(0);
}
