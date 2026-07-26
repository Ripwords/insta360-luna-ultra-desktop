import { describe, expect, it } from "vitest";
import { parseRawImageMeta, decodeRawPreview } from "~/utils/rawPreview";

/**
 * Build a minimal uncompressed CFA (Bayer) DNG: IFD0 holds the raw sensor
 * strip directly — 16-bit little-endian samples, RGGB pattern — exactly how
 * the Insta360 Luna writes its DNGs (no embedded preview JPEG anywhere).
 */
function buildRawDng(opts: {
  width: number;
  height: number;
  samples: number[]; // width*height 16-bit values, row-major
  whiteLevel?: number;
  blackLevel?: number;
}): ArrayBuffer {
  const { width, height, samples } = opts;
  const white = opts.whiteLevel ?? 65535;
  const black = opts.blackLevel ?? 0;
  const little = true;

  const tags: Array<{ tag: number; type: number; value: number }> = [
    { tag: 0x0100, type: 3, value: width }, // ImageWidth
    { tag: 0x0101, type: 3, value: height }, // ImageLength
    { tag: 0x0102, type: 3, value: 16 }, // BitsPerSample
    { tag: 0x0103, type: 3, value: 1 }, // Compression = none
    { tag: 0x0106, type: 3, value: 32803 }, // PhotometricInterpretation = CFA
    { tag: 0x0115, type: 3, value: 1 }, // SamplesPerPixel
    { tag: 0x0117, type: 4, value: samples.length * 2 }, // StripByteCounts
    { tag: 0xc61d, type: 4, value: white }, // WhiteLevel
    { tag: 0xc61a, type: 3, value: black }, // BlackLevel (SHORT, single)
    { tag: 0x828e, type: 1, value: 0 }, // CFAPattern placeholder, filled below
    { tag: 0x0111, type: 4, value: 0 }, // StripOffsets, filled below
  ];
  const entryCount = tags.length;
  const ifdSize = 2 + entryCount * 12 + 4;
  const cfaOffset = 8 + ifdSize; // CFAPattern (4 bytes) stored after the IFD
  const stripOffset = cfaOffset + 4;
  const total = stripOffset + samples.length * 2;
  const buf = new ArrayBuffer(total);
  const v = new DataView(buf);

  v.setUint16(0, 0x4949, false);
  v.setUint16(2, 42, little);
  v.setUint32(4, 8, little);

  v.setUint16(8, entryCount, little);
  tags.forEach((t, i) => {
    const o = 8 + 2 + i * 12;
    v.setUint16(o, t.tag, little);
    if (t.tag === 0x828e) {
      // CFAPattern: 4 BYTEs RGGB = [0,1,1,2], value > 4 bytes? no, exactly 4 -> inline
      v.setUint16(o + 2, 1, little); // type BYTE
      v.setUint32(o + 4, 4, little); // count 4
      v.setUint8(o + 8, 0);
      v.setUint8(o + 9, 1);
      v.setUint8(o + 10, 1);
      v.setUint8(o + 11, 2);
    } else if (t.tag === 0x0111) {
      v.setUint16(o + 2, 4, little);
      v.setUint32(o + 4, 1, little);
      v.setUint32(o + 8, stripOffset, little);
    } else {
      v.setUint16(o + 2, t.type, little);
      v.setUint32(o + 4, 1, little);
      if (t.type === 3) v.setUint16(o + 8, t.value, little);
      else v.setUint32(o + 8, t.value, little);
    }
  });
  v.setUint32(8 + 2 + entryCount * 12, 0, little); // no next IFD

  for (let i = 0; i < samples.length; i++) v.setUint16(stripOffset + i * 2, samples[i]!, little);
  return buf;
}

/** Fill a width*height RGGB frame where every 2x2 block has the given raw channel values. */
function flatFrame(width: number, height: number, r: number, g: number, b: number): number[] {
  const out = Array.from({ length: width * height }, () => 0);
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      out[y * width + x] = r; // R
      out[y * width + x + 1] = g; // G
      out[(y + 1) * width + x] = g; // G
      out[(y + 1) * width + x + 1] = b; // B
    }
  }
  return out;
}

describe("parseRawImageMeta", () => {
  it("reads the uncompressed CFA raw IFD", () => {
    const buf = buildRawDng({ width: 4, height: 4, samples: flatFrame(4, 4, 100, 200, 50) });
    const meta = parseRawImageMeta(buf);
    expect(meta).not.toBeNull();
    expect(meta!.width).toBe(4);
    expect(meta!.height).toBe(4);
    expect(meta!.compression).toBe(1);
    expect(meta!.photometric).toBe(32803);
    expect(meta!.cfaPattern).toEqual([0, 1, 1, 2]);
    expect(meta!.whiteLevel).toBe(65535);
  });

  it("returns null for non-raw TIFF (no CFA IFD)", () => {
    const junk = new Uint8Array([1, 2, 3, 4]).buffer;
    expect(parseRawImageMeta(junk)).toBeNull();
  });
});

describe("decodeRawPreview", () => {
  it("demosaics to RGBA at the requested max dimension", () => {
    const buf = buildRawDng({ width: 8, height: 8, samples: flatFrame(8, 8, 40000, 40000, 40000) });
    const meta = parseRawImageMeta(buf)!;
    const out = decodeRawPreview(buf, meta, 4);
    expect(out).not.toBeNull();
    expect(out!.width).toBeLessThanOrEqual(4);
    expect(out!.height).toBeLessThanOrEqual(4);
    expect(out!.data.length).toBe(out!.width * out!.height * 4);
    // Alpha is fully opaque
    for (let i = 3; i < out!.data.length; i += 4) expect(out!.data[i]).toBe(255);
  });

  it("gray-world balances a neutral frame to near-neutral output", () => {
    // Raw green is twice red/blue (typical Bayer). Gray-world should equalize.
    const buf = buildRawDng({
      width: 16,
      height: 16,
      samples: flatFrame(16, 16, 20000, 40000, 20000),
    });
    const meta = parseRawImageMeta(buf)!;
    const out = decodeRawPreview(buf, meta, 4)!;
    const [r, g, b] = [out.data[0]!, out.data[1]!, out.data[2]!];
    // After white balance the three channels should land close together.
    expect(Math.abs(r - g)).toBeLessThan(24);
    expect(Math.abs(b - g)).toBeLessThan(24);
    // And it should be a mid/high tone, not black.
    expect(g).toBeGreaterThan(80);
  });

  it("still decodes when the buffer is truncated a few bytes short of EOF", () => {
    const full = buildRawDng({
      width: 32,
      height: 32,
      samples: flatFrame(32, 32, 30000, 30000, 30000),
    });
    // Chop the tail: a streamed download that stopped a few bytes early.
    const truncated = full.slice(0, full.byteLength - 200);
    const meta = parseRawImageMeta(truncated)!;
    expect(meta).not.toBeNull();
    const out = decodeRawPreview(truncated, meta, 8);
    expect(out).not.toBeNull();
    expect(out!.height).toBeGreaterThan(0);
  });

  it("routes CFA channels correctly (red-dominant raw -> red output) with WB off", () => {
    const buf = buildRawDng({
      width: 16,
      height: 16,
      samples: flatFrame(16, 16, 60000, 20000, 20000),
    });
    const meta = parseRawImageMeta(buf)!;
    const out = decodeRawPreview(buf, meta, 4, { whiteBalance: "none" })!;
    const [r, g, b] = [out.data[0]!, out.data[1]!, out.data[2]!];
    expect(r).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(b);
  });
});
