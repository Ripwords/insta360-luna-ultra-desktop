#!/usr/bin/env node
// Decode a packet capture of the camera's control channel.
//
//   node scripts/decode-capture.mjs <capture.pcapng|stream.bin> [--port 6666]
//
// The point of this is the commands we cannot make ourselves. Deep Track,
// tap-to-focus and Colour Recovery are all driven from the phone app, and none
// of them shows up in any option the camera will let us read — so the only way
// to learn their message codes is to watch the phone issue them.
//
// Accepts either a pcap/pcapng (decoded via tshark) or a raw TCP stream saved
// from Wireshark's "Follow TCP Stream -> Show data as Raw".
//
// Frames are UCD2: 12-byte header, body, 4-byte checksum, with the message code
// in the first two bytes of the body. Codes the schema cannot name are the
// interesting ones — those are what this camera added.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { drainFrames } from "./lib/ucd2.mjs";
import { decodeRaw } from "./lib/protobuf.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(fs.readFileSync(path.join(here, "luna-protocol-schema.json"), "utf8"));
const CODES = schema.enums["insta360.messages.MessageCode"] ?? {};

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PORT = flag("port", "6666");

if (!file || !fs.existsSync(file)) {
  console.error("usage: node scripts/decode-capture.mjs <capture.pcapng|stream.bin> [--port 6666]");
  process.exit(1);
}

/**
 * Pull the TCP payloads out of a capture, keeping the two directions apart.
 *
 * Direction matters: a request from the phone and the camera's answer to it
 * share a code, and mixing them makes every command look like it happened
 * twice.
 */
function streamsFromCapture(capturePath) {
  let output;
  try {
    output = execFileSync(
      "tshark",
      [
        "-r", capturePath,
        "-Y", `tcp.port==${PORT} && tcp.len>0`,
        "-T", "fields",
        "-e", "ip.src",
        "-e", "ip.dst",
        "-e", "tcp.payload",
      ],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    );
  } catch (error) {
    console.error("tshark could not read that capture.");
    console.error(error.stderr?.toString().trim() || error.message);
    process.exit(1);
  }

  const byDirection = new Map();
  for (const line of output.split("\n")) {
    const [src, dst, payload] = line.split("\t");
    if (!payload) continue;
    const key = `${src} -> ${dst}`;
    const hex = payload.replaceAll(":", "");
    byDirection.set(key, [...(byDirection.get(key) ?? []), Buffer.from(hex, "hex")]);
  }
  return [...byDirection].map(([label, parts]) => ({ label, bytes: Buffer.concat(parts) }));
}

const isCapture = /\.pcapn?g?$/i.test(file);
const streams = isCapture
  ? streamsFromCapture(file)
  : [{ label: path.basename(file), bytes: fs.readFileSync(file) }];

if (streams.length === 0) {
  console.log(`No TCP payload on port ${PORT} in ${file}.`);
  console.log("");
  console.log("If this was meant to capture the camera, it did not: check that the");
  console.log("capture ran on the interface facing the camera, and that the traffic");
  console.log("you wanted actually happened while it was running.");
  process.exit(0);
}

const seen = new Map();

for (const stream of streams) {
  const { frames } = drainFrames(stream.bytes);
  const withCode = frames.filter((frame) => frame.code !== undefined);
  console.log(`\n${"=".repeat(72)}\n${stream.label}`);
  console.log(`${stream.bytes.length}B, ${frames.length} frame(s), ${withCode.length} with a code`);
  console.log("=".repeat(72));

  for (const frame of withCode) {
    const name = CODES[String(frame.code)] ?? null;
    seen.set(frame.code, (seen.get(frame.code) ?? 0) + 1);
    console.log(`\ncode ${frame.code}  ${name ?? "<< NOT IN SCHEMA >>"}  req ${frame.requestId}`);
    if (!frame.body?.length) {
      console.log("  (empty body)");
      continue;
    }
    console.log(`  ${frame.body.length}B  ${frame.body.toString("hex")}`);
    // No message name to annotate against — the code tells you what it is, and
    // for an unknown code there is nothing to look up anyway. Raw fields are
    // what we are after: which numbers moved, and what shape they came in.
    for (const record of decodeRaw(frame.body)) {
      const value =
        record.value instanceof Buffer
          ? `${record.value.length}B 0x${record.value.toString("hex")}`
          : record.value;
      console.log(`    field ${record.field} (wire ${record.wire}) = ${value}`);
    }
  }
}

console.log(`\n${"=".repeat(72)}\nCODES SEEN\n${"=".repeat(72)}`);
for (const [code, count] of [...seen].sort((a, b) => a[0] - b[0])) {
  const name = CODES[String(code)];
  console.log(`  ${String(code).padStart(6)}  x${String(count).padEnd(4)} ${name ?? "<< NOT IN SCHEMA >> — this is the interesting kind"}`);
}
if (seen.size === 0) console.log("  none — no UCD2 frames found in this capture");
