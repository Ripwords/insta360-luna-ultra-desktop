#!/usr/bin/env node
// Probe: what can the Luna Ultra's preview stream and gimbal do beyond what
// the app uses? Investigation tool, nothing here ships. Quit the desktop app
// and the Insta360 phone app first; the camera takes one control session at a
// time.
//
//   node scripts/probe-streaming.mjs [--host 192.168.42.1] [--port 6666] [--only info,audio,res]
//
// Phases, each logged to probe-out/streaming-log.txt. The default runs only
// the ones that neither move the camera nor touch its Wi-Fi.
//   info            Wi-Fi connection info the camera reports.
//   audio           START_LIVE_STREAM with and without enableAudio: which
//                   substreams arrive, and whether one looks like AAC (ADTS
//                   sync word). Non-video substreams are written to
//                   probe-out/audio-<substream>.bin.
//   res             START_LIVE_STREAM asking for 1080p30, 1080p60, 2160p30 and
//                   720p30. Each run's video goes to probe-out/res-<value>.h26x;
//                   check what arrived with ffprobe.
//   join            Station mode: SET_WIFI_CONNECTION_INFO with LUNA_STA_SSID and
//                   LUNA_STA_PASSWORD from the environment. Skipped unless both
//                   are set. The password is never logged.
//   gimbal-idle     GIMBAL_CONTROL (226) with the preview stopped: four short
//                   moves, then recenter. Logs PTZ notifications (8302).
//   gimbal-preview  The same command while the preview streams, in three
//                   session setups (plain; registered like the official app;
//                   registered plus a gimbal speed write). Each run's video goes
//                   to probe-out/gimbal-<variant>.h26x: ~1.5 s still, a 2 s pan,
//                   ~1 s settle, so comparing its first and last frames shows
//                   whether the gimbal moved.
//
// Findings on a Luna Ultra (2026-11-14): no audio substream with enableAudio
// (0x20 video, 0x30, 0x40 gyro either way); 1280x720 H.265 whatever the
// requested resolution; GIMBAL_CONTROL acknowledged but ignored with the
// preview stopped, obeyed in all three setups with it running.
import fs from "node:fs";
import path from "node:path";
import { LunaSession, fieldVarint, varint } from "./lib/ucd2.mjs";
import { decodeRaw } from "./lib/protobuf.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const HOST = flag("host", "192.168.42.1");
const PORT = Number(flag("port", "6666"));
const ONLY = new Set(flag("only", "info,audio,res").split(","));

const CODE_START_LIVE_STREAM = 1;
const CODE_STOP_LIVE_STREAM = 2;
const CODE_SET_ACCESS_CAMERA_FILE_STATE = 118;
const CODE_SET_WIFI_CONNECTION_INFO = 112;
const CODE_GET_WIFI_CONNECTION_INFO = 113;
const NOTIFY_WIFI_CONNECTION_RESULT = 8232;
const NOTIFY_LIVE_STREAM_PARAMS = 8234;
const ACCESS_STATE_LIVE_VIEW = 5;
const CODE_GIMBAL_CONTROL = 226;
const NOTIFY_PTZ_STATE = 8302;
const GIMBAL_MOVE = 1;
const GIMBAL_BACK_CENTER = 2;
const UCD2_MEDIA = 0x01;
const MEDIA_HEADER_LEN = 9;
const WIFI_RESULTS = ["SUCCESS", "TIMEOUT", "ERROR_CONNECT_FAILED"];

const OUT = path.resolve("probe-out");
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, "streaming-log.txt");
const t0 = Date.now();
const lines = [];
const say = (line) => {
  const stamped = `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s ${line}`;
  lines.push(stamped);
  console.log(stamped);
};
const save = () => {
  fs.appendFileSync(
    LOG,
    `--- ${new Date().toISOString()} ${args.join(" ")}\n${lines.join("\n")}\n`,
  );
};

const fieldBytes = (number, bytes) =>
  Buffer.concat([varint((number << 3) | 2), varint(bytes.length), bytes]);
const fieldString = (number, text) => fieldBytes(number, Buffer.from(text, "utf8"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** Media payload as luna.rs reads it: substream byte, 8 more header bytes, data. */
function splitMedia(payload) {
  if (payload.length <= MEDIA_HEADER_LEN) return null;
  return {
    substream: payload[0],
    header: payload.subarray(0, MEDIA_HEADER_LEN),
    data: payload.subarray(MEDIA_HEADER_LEN),
  };
}

async function open() {
  const session = new LunaSession(HOST, PORT);
  session.media = null;
  session.onUnsolicited = (frame) => {
    if (frame.type === UCD2_MEDIA) {
      const media = splitMedia(frame.payload);
      if (media && session.media) session.media(media);
      return;
    }
    if (frame.code === undefined) return;
    if (frame.code === NOTIFY_PTZ_STATE) {
      session.ptz = (session.ptz ?? 0) + 1;
      if (session.ptz <= 40) say(`  notify PTZ_STATE ${render(frame.body)}`);
      return;
    }
    if (frame.code === NOTIFY_LIVE_STREAM_PARAMS)
      say(`  notify LIVE_STREAM_PARAMS ${render(frame.body)}`);
    else if (frame.code === NOTIFY_WIFI_CONNECTION_RESULT) session.onWifiResult?.(frame);
    else say(`  notify ${frame.code} ${render(frame.body)}`);
  };
  await session.connect();
  session.socket.on("close", () => say("control connection closed"));
  session.socket.on("error", (error) => say(`control connection error: ${error.message}`));
  say(`connected to ${HOST}:${PORT}`);
  return session;
}

async function ask(session, label, code, body = Buffer.alloc(0), timeoutMs = 5000) {
  const reply = await session.send(code, body, timeoutMs);
  say(
    `${label}: ${reply ? `reply ${render(reply.body)}` : `no reply within ${timeoutMs / 1000}s`}`,
  );
  return reply;
}

/** Runs one START_LIVE_STREAM for `seconds`, tallying substreams. */
async function stream(session, label, fields, seconds, onMedia) {
  const tally = new Map();
  session.media = (media) => {
    const entry = tally.get(media.substream) ?? {
      frames: 0,
      bytes: 0,
      head: media.data.subarray(0, 16).toString("hex"),
    };
    entry.frames++;
    entry.bytes += media.data.length;
    tally.set(media.substream, entry);
    onMedia?.(media);
  };
  await ask(
    session,
    `${label} announce LIVE_VIEW`,
    CODE_SET_ACCESS_CAMERA_FILE_STATE,
    fieldVarint(1, ACCESS_STATE_LIVE_VIEW),
    2000,
  );
  const body = Buffer.concat(fields.map(([number, value]) => fieldVarint(number, value)));
  await ask(session, `${label} START`, CODE_START_LIVE_STREAM, body);
  await sleep(seconds * 1000);
  await ask(session, `${label} STOP`, CODE_STOP_LIVE_STREAM);
  session.media = null;
  await sleep(1000);
  for (const [substream, entry] of [...tally].sort((a, b) => a[0] - b[0])) {
    say(
      `  substream 0x${substream.toString(16)}: ${entry.frames} frames, ${entry.bytes} bytes, first ${entry.head}`,
    );
  }
  if (tally.size === 0) say("  no media frames");
  return tally;
}

const BASE = [
  [2, 1],
  [6, 40],
  [7, 9],
  [8, 1],
  [9, 40],
  [10, 18],
];

async function info(session) {
  await ask(session, "GET_WIFI_CONNECTION_INFO", CODE_GET_WIFI_CONNECTION_INFO);
}

async function audio(session) {
  say("baseline without enableAudio:");
  await stream(session, "baseline", BASE, 4);
  const files = new Map();
  const tally = await stream(
    session,
    "audio",
    [[1, 1], [3, 1], [4, 48000], [5, 128000], ...BASE],
    6,
    (media) => {
      if (media.substream === 0x20 || media.substream === 0x40) return;
      if (!files.has(media.substream)) files.set(media.substream, []);
      files.get(media.substream).push(media.data);
    },
  );
  for (const [substream, chunks] of files) {
    const bytes = Buffer.concat(chunks);
    fs.writeFileSync(path.join(OUT, `audio-0x${substream.toString(16)}.bin`), bytes);
    const adts = chunks.filter((chunk) => chunk[0] === 0xff && (chunk[1] & 0xf0) === 0xf0).length;
    say(
      `  substream 0x${substream.toString(16)}: ${adts}/${chunks.length} chunks start with an ADTS sync word`,
    );
  }
  const known = new Set([0x20, 0x30, 0x40]);
  const extra = [...tally.keys()].filter((substream) => !known.has(substream));
  say(
    extra.length
      ? `audio: NEW substreams ${extra.map((s) => `0x${s.toString(16)}`).join(", ")}`
      : "audio: no new substream",
  );
}

async function res(session) {
  // 29 1920x1080p30, 40 1920x1080p60, 24 3840x2160p30, 43 1280x720p30
  for (const value of [29, 40, 24, 43]) {
    const chunks = [];
    const fields = BASE.map(([number, v]) => [
      number,
      number === 7 ? value : number === 6 ? 80 : v,
    ]);
    await stream(session, `res ${value}`, fields, 4, (media) => {
      if (media.substream === 0x20) chunks.push(media.data);
    });
    const file = path.join(OUT, `res-${value}.h26x`);
    fs.writeFileSync(file, Buffer.concat(chunks));
    say(`  wrote ${chunks.length} chunks to ${path.basename(file)}`);
  }
}

async function join(session) {
  const ssid = process.env.LUNA_STA_SSID;
  const password = process.env.LUNA_STA_PASSWORD;
  if (!ssid || !password) {
    say("join: skipped (set LUNA_STA_SSID and LUNA_STA_PASSWORD)");
    return;
  }
  say(`join: sending SET_WIFI_CONNECTION_INFO for "${ssid}" (password ${password.length} chars)`);
  const settled = new Promise((resolve) => {
    session.onWifiResult = resolve;
    session.socket.once("close", () => resolve(null));
    setTimeout(() => resolve(undefined), 60_000);
  });
  const info = Buffer.concat([fieldString(1, ssid), fieldString(3, password)]);
  await ask(session, "join SET reply", CODE_SET_WIFI_CONNECTION_INFO, fieldBytes(1, info), 10_000);
  const result = await settled;
  if (result === undefined) say("join: no WIFI_CONNECTION_RESULT within 60s");
  else if (result === null)
    say("join: camera dropped the connection (it may have left its own Wi-Fi)");
  else {
    const rows = decodeRaw(result.body);
    const code = rows.find((row) => row.field === 1)?.value ?? 0;
    say(`join: result ${WIFI_RESULTS[code] ?? code} ${render(result.body)}`);
    await ask(session, "GET_WIFI_CONNECTION_INFO after join", CODE_GET_WIFI_CONNECTION_INFO);
  }
}

const zigzag = (n) => ((n << 1) ^ (n >> 31)) >>> 0;
/** Luna's axes are swapped on the wire: field 1 is tilt, field 2 is pan. */
function gimbalMove(pan, tilt) {
  const axes = Buffer.concat([
    tilt ? fieldVarint(1, zigzag(tilt)) : Buffer.alloc(0),
    pan ? fieldVarint(2, zigzag(pan)) : Buffer.alloc(0),
  ]);
  return Buffer.concat([fieldVarint(1, GIMBAL_MOVE), fieldBytes(2, axes)]);
}

async function gimbal(session) {
  const moves = [
    ["pan right", 50, 0],
    ["pan left", -50, 0],
    ["tilt up", 0, 50],
    ["tilt down", 0, -50],
  ];
  for (const [label, pan, tilt] of moves) {
    say(`gimbal: ${label} (pan ${pan}, tilt ${tilt}) for 2s at 10 Hz`);
    session.ptz = 0;
    const first = await session.send(CODE_GIMBAL_CONTROL, gimbalMove(pan, tilt), 2000);
    say(`  first reply: ${first ? render(first.body) || "(empty)" : "none within 2s"}`);
    for (let i = 0; i < 19; i++) {
      session.send(CODE_GIMBAL_CONTROL, gimbalMove(pan, tilt), 500);
      await sleep(100);
    }
    await ask(session, "  stop", CODE_GIMBAL_CONTROL, gimbalMove(0, 0), 2000);
    await sleep(800);
    say(`  PTZ_STATE notifications during the move: ${session.ptz}`);
  }
  await ask(
    session,
    "gimbal BACK_CENTER",
    CODE_GIMBAL_CONTROL,
    fieldVarint(1, GIMBAL_BACK_CENTER),
    2000,
  );
  await sleep(2000);
}

/** Sends a move at the official app's cadence (~40 ms) for `ms`, then four zero vectors. */
async function sweep(session, pan, tilt, ms) {
  const until = Date.now() + ms;
  let sent = 0;
  let replied = 0;
  while (Date.now() < until) {
    session
      .send(CODE_GIMBAL_CONTROL, gimbalMove(pan, tilt), 1000)
      .then((reply) => reply && replied++);
    sent++;
    await sleep(40);
  }
  for (let i = 0; i < 4; i++) {
    session.send(CODE_GIMBAL_CONTROL, gimbalMove(0, 0), 1000).then((reply) => reply && replied++);
    sent++;
    await sleep(40);
  }
  await sleep(600);
  say(
    `  sweep pan ${pan} tilt ${tilt}: sent ${sent}, replies ${replied}, PTZ notifications ${session.ptz ?? 0}`,
  );
}

/** The official app's session setup, from Insta360Linker's PCAP (2026-07-28). */
async function registerLikeOfficialApp(session) {
  const clientId = "ffffffff-6c75-6e61-ffff-ffff6465736b";
  const epoch = Math.floor(Date.now() / 1000);
  const zone = "Europe/Istanbul";
  const offset = -new Date().getTimezoneOffset() * 60;
  const values = Buffer.concat([
    Buffer.from([0x60]),
    varint(epoch),
    Buffer.from([0x68]),
    varint(offset),
    Buffer.from([0xfa, 0x0a]),
    varint(zone.length),
    Buffer.from(zone),
  ]);
  const timeBody = Buffer.concat([
    Buffer.from([0x08, 0x0c, 0x08, 0x0d, 0x08, 0xaf, 0x01, 0x12]),
    varint(values.length),
    values,
  ]);
  const steps = [
    ["GET_OPTIONS model/serial/battery", 0x0008, Buffer.from("0830080f080b", "hex")],
    ["0x000f", 0x000f, Buffer.alloc(0)],
    [
      "register client 0x0027",
      0x0027,
      Buffer.concat([fieldString(1, clientId), fieldVarint(2, 2)]),
    ],
    ["time sync 0x0007", 0x0007, timeBody],
    ["GET_OPTIONS status", 0x0008, Buffer.from("080b085508b401", "hex")],
    ["access LIVE_VIEW 0x0076", 0x0076, fieldVarint(1, ACCESS_STATE_LIVE_VIEW)],
    ["subscribe events 0x0011", 0x0011, fieldVarint(1, 1)],
  ];
  for (const [label, code, body] of steps) await ask(session, `  ${label}`, code, body, 4000);
}

/**
 * Finds out what makes the gimbal move. Each variant records the preview to
 * probe-out/gimbal-<variant>.h26x: ~1.5 s still, a 2 s pan, ~1 s settle. If
 * the gimbal moved, the first and last frames of the file differ a lot.
 */
async function gimbal2(first) {
  first.close();
  await sleep(1000);
  const variants = [
    { name: "A-stream", register: false, speed: false, pan: 60 },
    { name: "B-registered", register: true, speed: false, pan: -60 },
    { name: "C-registered-speed", register: true, speed: true, pan: 60 },
  ];
  for (const variant of variants) {
    say(`gimbal2 ${variant.name}`);
    const session = await open();
    await sleep(1500);
    if (variant.register) await registerLikeOfficialApp(session);
    if (variant.speed) {
      await ask(
        session,
        "  gimbal speed 3 (0x0009 option 0x55)",
        0x0009,
        Buffer.from("08551205aa050210031806", "hex"),
        4000,
      );
    }
    const chunks = [];
    let started = false;
    session.media = (media) => {
      if (media.substream === 0x20) chunks.push(media.data);
    };
    await ask(
      session,
      "  announce LIVE_VIEW",
      CODE_SET_ACCESS_CAMERA_FILE_STATE,
      fieldVarint(1, ACCESS_STATE_LIVE_VIEW),
      2000,
    );
    const startBody = Buffer.concat(BASE.map(([number, value]) => fieldVarint(number, value)));
    started = Boolean(await ask(session, "  START", CODE_START_LIVE_STREAM, startBody));
    await sleep(1500);
    session.ptz = 0;
    await sweep(session, variant.pan, 0, 2000);
    await sleep(400);
    await ask(session, "  STOP", CODE_STOP_LIVE_STREAM);
    session.media = null;
    fs.writeFileSync(path.join(OUT, `gimbal-${variant.name}.h26x`), Buffer.concat(chunks));
    say(`  wrote ${chunks.length} video chunks (stream started: ${started})`);
    session.close();
    await sleep(1200);
  }
}

let session;
try {
  session = await open();
  for (const [name, run] of Object.entries({
    info,
    audio,
    res,
    join,
    "gimbal-idle": gimbal,
    "gimbal-preview": gimbal2,
  })) {
    if (!ONLY.has(name)) continue;
    say(`=== ${name}`);
    try {
      await run(session);
    } catch (error) {
      say(`${name} failed: ${error.message}`);
    }
  }
} catch (error) {
  say(`failed: ${error.message}`);
} finally {
  session?.close();
  save();
  process.exit(0);
}
