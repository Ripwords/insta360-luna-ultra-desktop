/**
 * Byte-level Annex-B helpers for the camera live view.
 *
 * The camera hands us a raw elementary stream with no container, so
 * everything WebCodecs needs — which codec, which profile and level, where
 * one frame ends and the next begins — has to be read off the wire. Keeping
 * this pure makes it testable without a camera attached.
 */

export type NalCodec = "h264" | "h265";

export interface AccessUnit {
  key: boolean;
  data: Uint8Array;
}

const START_CODE = new Uint8Array([0, 0, 0, 1]);

/** H.265 parameter sets: VPS, SPS, PPS. */
const H265_VPS = 32;
const H265_SPS = 33;
const H265_PPS = 34;
/** H.265 IRAP range (BLA_W_LP..CRA_NUT) — any of these starts a keyframe. */
const H265_IRAP_MIN = 16;
const H265_IRAP_MAX = 23;
/** H.265 NAL types below this are VCL (picture data). */
const H265_VCL_MAX = 31;

const H264_SPS = 7;
const H264_PPS = 8;
const H264_IDR = 5;
const H264_NON_IDR = 1;

/**
 * Split a raw Annex-B stream into NAL payloads, start codes removed.
 *
 * Single pass: a unit is emitted when the *next* start code proves where it
 * ended, so the scan needs no intermediate list of start positions. This runs
 * on every socket read for the whole of a live session, which is the only
 * reason it is written this tersely.
 */
export function splitNalUnits(bytes: Uint8Array): Uint8Array[] {
  const units: Uint8Array[] = [];
  const { length } = bytes;
  /** Payload start of the unit currently open, or -1 before the first one. */
  let from = -1;

  for (let i = 0; i + 2 < length; i++) {
    if (bytes[i] !== 0 || bytes[i + 1] !== 0) continue;
    let size: number;
    if (bytes[i + 2] === 1) size = 3;
    else if (bytes[i + 2] === 0 && bytes[i + 3] === 1) size = 4;
    else continue;
    if (from >= 0 && i > from) units.push(bytes.subarray(from, i));
    from = i + size;
    i += size - 1;
  }

  if (from >= 0 && length > from) units.push(bytes.subarray(from, length));
  return units;
}

/**
 * Remove emulation prevention bytes: the encoder inserts 0x03 after any
 * 0x00 0x00 pair so the payload can never contain a start code.
 */
function unescapeRbsp(unit: Uint8Array): Uint8Array {
  const out = new Uint8Array(unit.length);
  let written = 0;
  let zeros = 0;
  for (const byte of unit) {
    if (zeros === 2 && byte === 0x03) {
      zeros = 0;
      continue;
    }
    out[written++] = byte;
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, written);
}

export function nalType(unit: Uint8Array, codec: NalCodec): number {
  if (unit.length === 0) return -1;
  return codec === "h265" ? (unit[0]! >> 1) & 0x3f : unit[0]! & 0x1f;
}

/**
 * Distinguish the two codecs by their parameter-set NAL types. H.265 is
 * checked first because its VPS byte (0x40) decodes to an invalid H.264
 * type, so the two cannot be confused.
 */
export function detectCodec(units: Uint8Array[]): NalCodec | null {
  for (const unit of units) {
    if (unit.length === 0 || (unit[0]! & 0x80) !== 0) continue;
    const h265 = (unit[0]! >> 1) & 0x3f;
    if (h265 === H265_VPS || h265 === H265_SPS || h265 === H265_PPS) return "h265";
    const h264 = unit[0]! & 0x1f;
    if (h264 === H264_SPS || h264 === H264_PPS) return "h264";
  }
  return null;
}

const findSps = (units: Uint8Array[], codec: NalCodec) =>
  units.find((unit) => nalType(unit, codec) === (codec === "h265" ? H265_SPS : H264_SPS));

const hex = (value: number) => value.toString(16).padStart(2, "0");

/** Reverse a 32-bit value bit-by-bit, as the HEVC codec string requires. */
function reverseBits32(value: number): number {
  let out = 0;
  for (let bit = 0; bit < 32; bit++) {
    out = ((out << 1) | ((value >>> bit) & 1)) >>> 0;
  }
  return out >>> 0;
}

/**
 * Build the codec string `VideoDecoder.configure` expects.
 *
 * H.264 is `avc1.PPCCLL` — profile_idc, constraint flags and level_idc
 * straight out of the SPS. H.265 is `hvc1.A.B.C.D` per ISO/IEC 14496-15,
 * which needs the profile_tier_level structure decoded.
 */
export function buildCodecString(units: Uint8Array[], codec: NalCodec): string | null {
  const raw = findSps(units, codec);
  if (!raw) return null;
  const sps = unescapeRbsp(raw);

  if (codec === "h264") {
    if (sps.length < 4) return null;
    return `avc1.${hex(sps[1]!)}${hex(sps[2]!)}${hex(sps[3]!)}`;
  }

  // 2-byte NAL header, 1 byte of ids/flags, then profile_tier_level:
  // profile byte, 4 compatibility bytes, 6 constraint bytes, level byte.
  if (sps.length < 15) return null;

  const profileByte = sps[3]!;
  const profileSpace = (profileByte >> 6) & 0x03;
  const tierFlag = (profileByte >> 5) & 0x01;
  const profileIdc = profileByte & 0x1f;

  const compatibility = ((sps[4]! << 24) | (sps[5]! << 16) | (sps[6]! << 8) | sps[7]!) >>> 0;

  // Constraint bytes are conventionally written uppercase, as in the
  // canonical Main profile string hvc1.1.6.L93.B0
  const constraints: string[] = [];
  for (let i = 8; i < 14; i++) constraints.push(hex(sps[i]!).toUpperCase());
  while (constraints.length > 0 && constraints.at(-1) === "00") constraints.pop();

  const space = profileSpace === 0 ? "" : String.fromCharCode(64 + profileSpace);
  const tier = tierFlag === 0 ? "L" : "H";

  const parts = [
    `hvc1.${space}${profileIdc}`,
    reverseBits32(compatibility).toString(16),
    `${tier}${sps[14]!}`,
    ...constraints,
  ];
  return parts.join(".");
}

const isVcl = (type: number, codec: NalCodec) =>
  codec === "h265" ? type <= H265_VCL_MAX : type === H264_IDR || type === H264_NON_IDR;

const isKeyNal = (type: number, codec: NalCodec) =>
  codec === "h265" ? type >= H265_IRAP_MIN && type <= H265_IRAP_MAX : type === H264_IDR;

/**
 * A new access unit begins at the first slice of a picture. H.265 signals
 * this with first_slice_segment_in_pic_flag, the top bit after the 2-byte
 * header; H.264 signals it with first_mb_in_slice == 0, which as ue(v)
 * means the top bit after the 1-byte header is set.
 */
function startsPicture(unit: Uint8Array, codec: NalCodec): boolean {
  const offset = codec === "h265" ? 2 : 1;
  if (unit.length <= offset) return false;
  return (unit[offset]! & 0x80) !== 0;
}

/**
 * Streaming-safe wrapper around `groupAccessUnits`.
 *
 * Reads off the socket do not align with picture boundaries, so the trailing
 * picture in any buffer may still be incomplete. Only pictures proven finished
 * by the arrival of the *next* picture are emitted; everything from that next
 * picture onward — including any parameter sets that precede it — stays
 * pending. Flushing per read instead would emit headless fragments and drop
 * parameter sets that arrived without a slice behind them.
 */
export function drainAccessUnits(
  units: Uint8Array[],
  codec: NalCodec,
): { access: AccessUnit[]; pending: Uint8Array[] } {
  const pictureStarts: number[] = [];
  for (let i = 0; i < units.length; i++) {
    const type = nalType(units[i]!, codec);
    if (isVcl(type, codec) && startsPicture(units[i]!, codec)) pictureStarts.push(i);
  }
  // Fewer than two pictures means nothing is provably complete yet
  if (pictureStarts.length < 2) return { access: [], pending: units };

  // Parameter sets ahead of the last picture belong to it, so cut there
  const cut = pictureStarts.at(-1)!;
  let from = cut;
  while (from > 0 && !isVcl(nalType(units[from - 1]!, codec), codec)) from--;

  return {
    access: groupAccessUnits(units.slice(0, from), codec),
    pending: units.slice(from),
  };
}

/**
 * Group NAL units into decodable access units, re-adding start codes.
 * Leading parameter sets are carried into the access unit that follows them,
 * which is what lets the decoder configure itself from the first keyframe.
 */
export function groupAccessUnits(units: Uint8Array[], codec: NalCodec): AccessUnit[] {
  const access: AccessUnit[] = [];
  let pending: Uint8Array[] = [];
  let key = false;
  let seenVcl = false;

  const flush = () => {
    if (!seenVcl || pending.length === 0) return;
    const size = pending.reduce((total, unit) => total + START_CODE.length + unit.length, 0);
    const data = new Uint8Array(size);
    let at = 0;
    for (const unit of pending) {
      data.set(START_CODE, at);
      at += START_CODE.length;
      data.set(unit, at);
      at += unit.length;
    }
    access.push({ key, data });
    pending = [];
    key = false;
    seenVcl = false;
  };

  for (const unit of units) {
    const type = nalType(unit, codec);
    if (isVcl(type, codec) && startsPicture(unit, codec) && seenVcl) flush();
    if (isVcl(type, codec)) {
      seenVcl = true;
      if (isKeyNal(type, codec)) key = true;
    }
    pending.push(unit);
  }
  flush();
  return access;
}
