// UCD2 control-protocol framing for the probe scripts. Mirrors
// src-tauri/src/luna.rs so probes exercise the same wire format the app does.
// Investigation tooling only — nothing here ships in the desktop app.

import net from "node:net";

export const UCD2_MAGIC = Buffer.from("UCD2");
export const UCD2_VERSION = 0x01;
export const UCD2_FLAGS = 0x0c;
export const UCD2_MEDIA = 0x01;
export const UCD2_FILE = 0x04;
export const UCD2_STREAM = 0x05;

export const CONTROL_PORT = 6666;

export const CODE = {
  START_LIVE_STREAM: 1,
  STOP_LIVE_STREAM: 2,
  TAKE_PICTURE: 3,
  START_CAPTURE: 4,
  STOP_CAPTURE: 5,
  SET_OPTIONS: 7,
  GET_OPTIONS: 8,
  SET_PHOTOGRAPHY_OPTIONS: 9,
  GET_PHOTOGRAPHY_OPTIONS: 10,
  DELETE_FILES: 12,
  GET_CURRENT_CAPTURE_STATUS: 15,
};

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

/** Insta360's nonstandard CRC-32 variant; see the note in luna.rs. */
export function insta360Checksum(data) {
  let checksum = 0xffffffff;
  for (const byte of data) {
    checksum = (checksum ^ byte) >>> 0;
    for (let round = 0; round < 4; round++) {
      checksum = (((checksum << 8) >>> 0) ^ CRC_TABLE[checksum >>> 24]) >>> 0;
    }
  }
  return checksum >>> 0;
}

export function varint(value) {
  const out = [];
  while (value > 0x7f) {
    out.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 128);
  }
  out.push(value);
  return Buffer.from(out);
}

/** proto3 varint field — covers bool, uint32, int32 and enum. */
export const fieldVarint = (number, value) => Buffer.concat([varint(number << 3), varint(value)]);

export function buildUcd2(type, seq, payload) {
  const header = Buffer.alloc(8);
  UCD2_MAGIC.copy(header, 0);
  header[4] = UCD2_VERSION;
  header[5] = UCD2_FLAGS;
  header[6] = type;
  header[7] = seq & 0xff;
  return Buffer.concat([header, payload]);
}

export const buildStreamHello = (seq) =>
  buildUcd2(UCD2_STREAM, seq, Buffer.concat([Buffer.alloc(4), Buffer.from("f6cc4f09", "hex")]));

export function buildFileCommand(seq, code, requestId, body) {
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

/**
 * Scan complete frames out of a receive buffer. All three frame types share
 * the length formula `12 + declared + 4`. Returns { frames, rest }.
 */
export function drainFrames(buffer) {
  const frames = [];
  let at = 0;
  for (;;) {
    const start = buffer.indexOf(UCD2_MAGIC, at);
    if (start === -1 || start + 12 > buffer.length) break;
    const type = buffer[start + 6];
    const declared = buffer.readUInt32LE(start + 8);
    const total = 12 + declared + 4;
    if (start + total > buffer.length) break;

    const payload = buffer.subarray(start + 12, start + 12 + declared);
    if (type === UCD2_FILE && declared >= 9) {
      frames.push({
        type,
        code: payload.readUInt16LE(0),
        requestId: payload.readUInt16LE(3),
        body: payload.subarray(9),
      });
    } else {
      frames.push({ type, payload });
    }
    at = start + total;
  }
  return { frames, rest: buffer.subarray(at) };
}

/** A live control session: handshake, request/response correlation, keepalive. */
export class LunaSession {
  constructor(host, port = CONTROL_PORT) {
    this.host = host;
    this.port = port;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.seq = 0x24;
    this.requestId = 100;
    this.keepalive = null;
    /** Set to receive frames that answer no request of ours — camera notifications. */
    this.onUnsolicited = null;
  }

  nextSeq() {
    return this.seq++ & 0xff;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection({ host: this.host, port: this.port });
      this.socket.once("error", reject);
      this.socket.on("data", (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const { frames, rest } = drainFrames(this.buffer);
        this.buffer = rest;
        for (const frame of frames) {
          const settle = this.pending.get(frame.requestId);
          if (settle) {
            this.pending.delete(frame.requestId);
            settle(frame);
          } else {
            this.onUnsolicited?.(frame);
          }
        }
      });
      this.socket.once("connect", () => {
        // The stream hello is what authorises the session
        this.socket.write(buildStreamHello(this.nextSeq()));
        this.keepalive = setInterval(
          () => this.socket.write(buildStreamHello(this.nextSeq())),
          3000,
        );
        resolve();
      });
    });
  }

  send(code, body, timeoutMs = 5000) {
    const requestId = this.requestId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(null);
      }, timeoutMs);
      this.pending.set(requestId, (frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
      this.socket.write(buildFileCommand(this.nextSeq(), code, requestId, body));
    });
  }

  close() {
    if (this.keepalive) clearInterval(this.keepalive);
    this.socket?.end();
  }
}
