#!/usr/bin/env node
// Feasibility probe for camera live view. Read-only investigation tool: it
// opens a control session exactly like src-tauri/src/luna.rs does, asks the
// camera to start a preview stream, and dumps whatever comes back so we can
// see how video frames are actually framed. Nothing here ships.
//
//   node scripts/probe-liveview.mjs [--host 192.168.42.1] [--seconds 8]
//
// Writes ./probe-out/tcp-dump.bin  (raw socket bytes)
//        ./probe-out/report.txt    (same analysis printed to stdout)

import net from "node:net";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const HOST = flag("host", "192.168.42.1");
const SECONDS = Number(flag("seconds", "8"));
const CONTROL_PORT = 6666;
const OUT_DIR = path.resolve("probe-out");

const UCD2_MAGIC = Buffer.from("UCD2");
const UCD2_VERSION = 0x01;
const UCD2_FLAGS = 0x0c;
const UCD2_FILE = 0x04;
const UCD2_STREAM = 0x05;

const CODE_START_LIVE_STREAM = 1;
const CODE_STOP_LIVE_STREAM = 2;
const CODE_GET_OPTIONS = 8;
const CODE_GET_CURRENT_CAPTURE_STATUS = 15;

const lines = [];
const say = (...parts) => {
  const text = parts.join(" ");
  lines.push(text);
  console.log(text);
};

// ---------------------------------------------------------------- framing --
// Ported from luna.rs so the probe is byte-identical to what the app sends.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = (i << 24) >>> 0;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 0x80000000 ? (((value << 1) >>> 0) ^ 0x04c11db7) >>> 0 : (value << 1) >>> 0;
    }
    table[i] = value;
  }
  return table;
})();

function insta360Checksum(data) {
  let checksum = 0xffffffff;
  for (const byte of data) {
    checksum = (checksum ^ byte) >>> 0;
    for (let round = 0; round < 4; round++) {
      checksum = (((checksum << 8) >>> 0) ^ CRC_TABLE[checksum >>> 24]) >>> 0;
    }
  }
  return checksum >>> 0;
}

function varint(value) {
  const out = [];
  while (value > 0x7f) {
    out.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  out.push(value);
  return Buffer.from(out);
}

/** proto3 varint field (covers bool, uint32 and enum — all StartLiveStream needs). */
const field = (number, value) => Buffer.concat([varint(number << 3), varint(value)]);

function buildUcd2(type, seq, payload) {
  const header = Buffer.alloc(8);
  UCD2_MAGIC.copy(header, 0);
  header[4] = UCD2_VERSION;
  header[5] = UCD2_FLAGS;
  header[6] = type;
  header[7] = seq & 0xff;
  return Buffer.concat([header, payload]);
}

const buildStreamHello = (seq) =>
  buildUcd2(UCD2_STREAM, seq, Buffer.concat([Buffer.alloc(4), Buffer.from("f6cc4f09", "hex")]));

function buildFileCommand(seq, code, requestId, body) {
  const head = Buffer.alloc(9);
  head.writeUInt16LE(code, 0);
  head[2] = 0x02;
  head.writeUInt16LE(requestId, 3);
  head.writeUInt32LE(0x8000, 5);
  const raw = Buffer.concat([head, body]);

  const length = Buffer.alloc(4);
  length.writeUInt32LE(raw.length, 0);
  const frame = buildUcd2(UCD2_FILE, seq, Buffer.concat([length, raw]));

  const trailer = Buffer.alloc(4);
  trailer.writeUInt32LE(insta360Checksum(frame), 0);
  return Buffer.concat([frame, trailer]);
}

// The device-info probe bodies luna.rs sends during connect.
const smallOptionsBody = () => Buffer.concat([field(1, 48), field(1, 15), field(1, 11)]);

/**
 * StartLiveStream, per insta360.messages.StartLiveStream:
 *   2 enableVideo, 6 videoBitrate, 7 resolution, 8 enableGyro,
 *   9 videoBitrate1, 10 resolution1, 11 previewStreamNum
 * Values mirror the known-good capture from NiklasVoigt/Insta360-Livestream
 * (resolution 9 = RES_1440_720P30, resolution1 18 = RES_480_240P30).
 */
const startLiveStreamBody = () =>
  Buffer.concat([
    field(2, 1), // enableVideo
    field(6, 40), // videoBitrate
    field(7, 9), // resolution   RES_1440_720P30
    field(8, 1), // enableGyro
    field(9, 40), // videoBitrate1
    field(10, 18), // resolution1  RES_480_240P30
  ]);

// ----------------------------------------------------------- osc http probe --

async function probeOsc() {
  say("\n=== 1. OSC HTTP surface (port 80) ===");
  say("If the camera answers these, live preview may be available as plain MJPEG,");
  say("which would avoid HEVC decoding entirely.\n");

  const attempts = [
    { label: "GET /osc/info", method: "GET", path: "/osc/info" },
    { label: "POST /osc/state", method: "POST", path: "/osc/state", body: "" },
    {
      label: "POST /osc/commands/execute camera.getLivePreview",
      method: "POST",
      path: "/osc/commands/execute",
      body: JSON.stringify({ name: "camera.getLivePreview" }),
      previewOnly: true,
    },
  ];

  for (const attempt of attempts) {
    try {
      const response = await fetch(`http://${HOST}${attempt.path}`, {
        method: attempt.method,
        headers: { "Content-Type": "application/json;charset=utf-8" },
        body: attempt.body,
        signal: AbortSignal.timeout(4000),
      });
      const type = response.headers.get("content-type") ?? "(none)";
      say(
        `${attempt.label}\n  -> ${response.status} ${response.statusText}  content-type: ${type}`,
      );

      if (attempt.previewOnly) {
        // A live preview never ends; read a slice and look for JPEG SOI markers.
        const reader = response.body?.getReader();
        let collected = Buffer.alloc(0);
        const deadline = Date.now() + 3000;
        while (reader && collected.length < 200_000 && Date.now() < deadline) {
          const { value, done } = await reader.read();
          if (done) break;
          collected = Buffer.concat([collected, Buffer.from(value)]);
        }
        await reader?.cancel().catch(() => {});
        const jpegStarts = countMarker(collected, Buffer.from([0xff, 0xd8, 0xff]));
        say(`  -> read ${collected.length} bytes in ~3s, ${jpegStarts} JPEG SOI markers`);
        if (jpegStarts > 1) say("  -> LOOKS LIKE MJPEG. This is the easy path.");
        else if (collected.length > 0)
          say(`  -> first 64 bytes: ${collected.subarray(0, 64).toString("hex")}`);
      } else {
        const text = await response.text();
        say(`  -> ${text.slice(0, 400)}`);
      }
    } catch (error) {
      say(`${attempt.label}\n  -> failed: ${error.message}`);
    }
  }
}

const countMarker = (haystack, needle) => {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count++;
    at = haystack.indexOf(needle, at + 1);
  }
  return count;
};

// ------------------------------------------------------------- tcp probe --

function probeTcp() {
  return new Promise((resolve) => {
    say("\n=== 2. UCD2 control session + START_LIVE_STREAM (port 6666) ===");

    const socket = net.createConnection({ host: HOST, port: CONTROL_PORT });
    const chunks = [];
    let seq = 0x24;
    let bytesBeforeStart = 0;
    let started = false;
    const nextSeq = () => seq++ & 0xff;

    socket.setTimeout(6000);

    socket.on("connect", async () => {
      say(`connected to ${HOST}:${CONTROL_PORT}`);

      socket.write(buildStreamHello(nextSeq()));
      socket.write(buildFileCommand(nextSeq(), CODE_GET_OPTIONS, 1, smallOptionsBody()));
      socket.write(
        buildFileCommand(nextSeq(), CODE_GET_CURRENT_CAPTURE_STATUS, 2, Buffer.alloc(0)),
      );
      say("sent hello + device-info probes; waiting 2s for the session to settle");

      await new Promise((done) => setTimeout(done, 2000));
      bytesBeforeStart = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      started = true;

      const body = startLiveStreamBody();
      say(
        `sending START_LIVE_STREAM (code ${CODE_START_LIVE_STREAM}) body: ${body.toString("hex")}`,
      );
      socket.write(buildFileCommand(nextSeq(), CODE_START_LIVE_STREAM, 20, body));

      // Keep the session alive while the stream (hopefully) flows.
      const keepalive = setInterval(() => socket.write(buildStreamHello(nextSeq())), 3000);

      setTimeout(() => {
        clearInterval(keepalive);
        socket.write(buildFileCommand(nextSeq(), CODE_STOP_LIVE_STREAM, 21, Buffer.alloc(0)));
        setTimeout(() => socket.end(), 300);
      }, SECONDS * 1000);
    });

    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("timeout", () => {
      say("socket idle timeout");
      socket.destroy();
    });
    socket.on("error", (error) => say(`socket error: ${error.message}`));
    socket.on("close", () => {
      const dump = Buffer.concat(chunks);
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(path.join(OUT_DIR, "tcp-dump.bin"), dump);

      say(`\nreceived ${dump.length} bytes total (${bytesBeforeStart} before START_LIVE_STREAM)`);
      const afterStart = dump.length - bytesBeforeStart;
      if (!started) say("never reached the START_LIVE_STREAM step");
      else if (afterStart < 5000) {
        say(
          `only ${afterStart} bytes arrived after START_LIVE_STREAM — the camera likely rejected it.`,
        );
        say("Check report for any FILE response with code 1; its body may carry an error.");
      } else {
        say(
          `${afterStart} bytes arrived after START_LIVE_STREAM (~${Math.round(afterStart / SECONDS / 1024)} KiB/s).`,
        );
        say("That is a video-rate flow. Live view is viable over this socket.");
      }

      analyze(dump);
      resolve();
    });
  });
}

/**
 * The real question this probe answers: luna.rs assumes every STREAM (0x05)
 * frame is exactly 16 bytes. Scan by magic and measure the true gaps.
 */
function analyze(dump) {
  say("\n=== 3. Frame analysis ===");

  const positions = [];
  let at = dump.indexOf(UCD2_MAGIC);
  while (at !== -1) {
    positions.push(at);
    at = dump.indexOf(UCD2_MAGIC, at + 1);
  }
  say(`found ${positions.length} UCD2 magic positions`);
  if (positions.length === 0) {
    say("no UCD2 framing at all — video may use a different container. Inspect tcp-dump.bin.");
    return;
  }

  const byType = new Map();
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i];
    if (start + 12 > dump.length) break;
    const type = dump[start + 6];
    const gap = (positions[i + 1] ?? dump.length) - start;
    const declared = dump.readUInt32LE(start + 8);

    const entry = byType.get(type) ?? { count: 0, gaps: new Set(), samples: [] };
    entry.count++;
    entry.gaps.add(gap);
    if (entry.samples.length < 4) {
      entry.samples.push({ gap, declared, head: dump.subarray(start, start + 32).toString("hex") });
    }
    byType.set(type, entry);
  }

  for (const [type, entry] of [...byType].sort((a, b) => b[1].count - a[1].count)) {
    const name = type === UCD2_FILE ? "FILE" : type === UCD2_STREAM ? "STREAM" : "UNKNOWN";
    const gaps = [...entry.gaps].sort((a, b) => a - b);
    say(`\ntype 0x${type.toString(16).padStart(2, "0")} (${name}): ${entry.count} frames`);
    say(
      `  distinct sizes: ${gaps.length > 8 ? `${gaps.length} values, ${gaps[0]}..${gaps.at(-1)}` : gaps.join(", ")}`,
    );

    if (type === UCD2_STREAM) {
      const onlyHello = gaps.length === 1 && gaps[0] === 16;
      say(
        onlyHello
          ? "  all 16 bytes — these are just keepalive echoes, no video rode this type."
          : "  NOT all 16 bytes. luna.rs's hardcoded 16 is wrong here; video is carried on STREAM frames.",
      );
    }
    for (const sample of entry.samples) {
      const matches = sample.gap === 12 + sample.declared + 4 ? "  (gap == 12+len+4)" : "";
      say(`  sample gap=${sample.gap} uint32LE@8=${sample.declared}${matches}\n    ${sample.head}`);
    }
  }

  // Codec fingerprinting on the raw bytes.
  say("\n--- codec markers in the raw dump ---");
  const annexB = countMarker(dump, Buffer.from([0x00, 0x00, 0x00, 0x01]));
  say(`Annex-B start codes (00000001): ${annexB}`);
  say(`JPEG SOI (ffd8ff): ${countMarker(dump, Buffer.from([0xff, 0xd8, 0xff]))}`);
  if (annexB > 10) {
    say("Annex-B present -> raw H.264/H.265 elementary stream.");
    say(
      "Try: ffplay probe-out/tcp-dump.bin   (expect garbage frames from interleaved headers, but motion visible)",
    );
  }
}

const main = async () => {
  say(`probing ${HOST} for live view support`);
  await probeOsc();
  await probeTcp();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "report.txt"), lines.join("\n"));
  say(`\nwrote ${path.join(OUT_DIR, "report.txt")} and tcp-dump.bin`);
};

main();
