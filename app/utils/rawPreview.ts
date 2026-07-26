/**
 * Pure-TypeScript preview renderer for uncompressed CFA (Bayer) RAW/DNG files
 * that carry no embedded JPEG — e.g. the Insta360 Luna, whose DNGs store only
 * 16-bit raw sensor data. We locate the raw IFD, subsample-and-demosaic the
 * Bayer mosaic down to a preview-sized RGB image, apply a gray-world white
 * balance and sRGB gamma, and hand back RGBA pixels for a <canvas> to encode.
 *
 * This is deliberately a *preview* pipeline: nearest-block downsampling and
 * gray-world balancing are cheap and good enough to recognise a shot, not a
 * substitute for a real RAW developer. No copyleft RAW library is involved.
 */

const TYPE_SIZE: Record<number, number> = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  6: 1,
  7: 1,
  8: 2,
  9: 4,
  10: 8,
  11: 4,
  12: 8,
  13: 4,
};

export interface RawImageMeta {
  width: number;
  height: number;
  bitsPerSample: number;
  compression: number;
  photometric: number;
  stripOffset: number;
  stripByteCount: number;
  /** 2x2 CFA colour indices, 0=R 1=G 2=B, row-major (e.g. [0,1,1,2] = RGGB) */
  cfaPattern: number[];
  blackLevel: number;
  whiteLevel: number;
}

interface Reader {
  view: DataView;
  little: boolean;
  u16: (o: number) => number;
  u32: (o: number) => number;
}

function makeReader(buffer: ArrayBuffer): Reader | null {
  const view = new DataView(buffer);
  if (view.byteLength < 8) return null;
  const order = view.getUint16(0, false);
  let little: boolean;
  if (order === 0x4949) little = true;
  else if (order === 0x4d4d) little = false;
  else return null;
  if (view.getUint16(2, little) !== 42) return null;
  return {
    view,
    little,
    u16: (o) => view.getUint16(o, little),
    u32: (o) => view.getUint32(o, little),
  };
}

function entryValues(r: Reader, entryOffset: number): number[] {
  const { view } = r;
  const type = r.u16(entryOffset + 2);
  const count = r.u32(entryOffset + 4);
  const size = (TYPE_SIZE[type] ?? 1) * count;
  const base = size > 4 ? r.u32(entryOffset + 8) : entryOffset + 8;
  const step = TYPE_SIZE[type] ?? 1;
  const values: number[] = [];
  for (let i = 0; i < count; i++) {
    const o = base + i * step;
    if (o + step > view.byteLength) break;
    if (type === 3) values.push(r.u16(o));
    else if (type === 4 || type === 13) values.push(r.u32(o));
    else if (type === 1 || type === 6 || type === 7) values.push(view.getUint8(o));
    else if (type === 5) values.push(r.u32(o) / (r.u32(o + 4) || 1)); // RATIONAL
  }
  return values;
}

/**
 * Walk the TIFF/DNG IFD tree (IFD0 chain + SubIFDs) and return the first IFD
 * that looks like an uncompressed CFA raw image. Returns null when there is no
 * such image (e.g. a file that only holds a JPEG preview).
 */
export function parseRawImageMeta(buffer: ArrayBuffer): RawImageMeta | null {
  const reader = makeReader(buffer);
  if (!reader) return null;
  const { view } = reader;
  const visited = new Set<number>();
  let found: RawImageMeta | null = null;

  const walk = (ifdOffset: number, depth: number): void => {
    if (
      found ||
      depth > 4 ||
      ifdOffset <= 0 ||
      ifdOffset + 2 > view.byteLength ||
      visited.has(ifdOffset)
    )
      return;
    visited.add(ifdOffset);
    const count = reader.u16(ifdOffset);

    const tag: Record<number, number[]> = {};
    const subIfds: number[] = [];
    for (let i = 0; i < count; i++) {
      const eo = ifdOffset + 2 + i * 12;
      if (eo + 12 > view.byteLength) break;
      const t = reader.u16(eo);
      const values = entryValues(reader, eo);
      tag[t] = values;
      if (t === 0x014a) subIfds.push(...values); // SubIFDs
    }

    const compression = tag[0x0103]?.[0] ?? -1;
    const photometric = tag[0x0106]?.[0] ?? -1;
    const width = tag[0x0100]?.[0] ?? 0;
    const height = tag[0x0101]?.[0] ?? 0;
    const strips = tag[0x0111] ?? []; // StripOffsets
    const counts = tag[0x0117] ?? []; // StripByteCounts
    const cfa = tag[0x828e]; // CFAPattern

    // Uncompressed CFA image stored as a single strip is what we can render.
    const isCfaRaw =
      compression === 1 &&
      photometric === 32803 &&
      !!cfa &&
      strips.length === 1 &&
      counts.length === 1;
    if (isCfaRaw && width > 0 && height > 0) {
      const black = tag[0xc61a]?.[0] ?? 0;
      const white = tag[0xc61d]?.[0] ?? (1 << (tag[0x0102]?.[0] ?? 16)) - 1;
      found = {
        width,
        height,
        bitsPerSample: tag[0x0102]?.[0] ?? 16,
        compression,
        photometric,
        stripOffset: strips[0]!,
        stripByteCount: counts[0]!,
        cfaPattern: cfa.slice(0, 4),
        blackLevel: black,
        whiteLevel: white,
      };
      return;
    }

    for (const sub of subIfds) walk(sub, depth + 1);
    walk(reader.u32(ifdOffset + 2 + count * 12), depth + 1); // next IFD
  };

  walk(reader.u32(4), 0);
  return found;
}

export interface DecodedPreview {
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
}

export interface DecodeOptions {
  /** gray-world auto white balance (default) or none (raw channel routing) */
  whiteBalance?: "grayworld" | "none";
}

/** sRGB transfer function on a linear [0,1] value -> [0,255]. */
function encodeSrgb(linear: number): number {
  const c = linear <= 0 ? 0 : linear >= 1 ? 1 : linear;
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

/**
 * Precomputed sRGB curve. The encode runs three times per output pixel — a few
 * million `Math.pow` calls on a full-frame preview — and the curve only ever
 * maps [0,1] to a byte, so a table costs one build and no transcendentals.
 * At this resolution the table lands within one 0-255 level of `encodeSrgb`,
 * which is far below the noise of a gray-world preview.
 */
const SRGB_STEPS = 4096;
const SRGB_TABLE = /* @__PURE__ */ (() => {
  const table = new Uint8Array(SRGB_STEPS + 1);
  for (let i = 0; i <= SRGB_STEPS; i++) table[i] = encodeSrgb(i / SRGB_STEPS);
  return table;
})();

const srgb = (linear: number): number =>
  SRGB_TABLE[linear <= 0 ? 0 : linear >= 1 ? SRGB_STEPS : (linear * SRGB_STEPS) | 0]!;

/**
 * Demosaic an uncompressed Bayer strip to a downscaled RGBA preview no larger
 * than `maxDim` on its longest side. Each output pixel samples one 2x2 CFA
 * block (nearest-block downsampling) so cost scales with the *preview* size,
 * not the ~37 MP sensor. Returns null if the raw is unsupported or truncated.
 */
export function decodeRawPreview(
  buffer: ArrayBuffer,
  meta: RawImageMeta,
  maxDim: number,
  opts: DecodeOptions = {},
): DecodedPreview | null {
  if (meta.compression !== 1) return null;
  const view = new DataView(buffer);
  const little = view.getUint16(0, false) === 0x4949;
  const { width, height, stripOffset } = meta;

  // Colour index (0=R 1=G 2=B) for each of the four positions in a 2x2 block.
  const p = meta.cfaPattern;
  if (p.length < 4 || width < 2 || height < 2 || stripOffset <= 0) return null;

  // The raw strip typically runs to the exact end of the file, so a streamed
  // download that stops even a few bytes short would fail the whole preview if
  // we demanded every row. Decode only as many full rows as actually arrived.
  const availableBytes = view.byteLength - stripOffset;
  const usableRows = Math.min(height, Math.floor(availableBytes / (width * 2)));
  if (usableRows < 2) return null;

  // Bayer blocks form a (width/2) x (usableRows/2) grid; scale that to <= maxDim.
  const blockW = Math.floor(width / 2);
  const blockH = Math.floor(usableRows / 2);
  const scale = Math.min(1, maxDim / Math.max(blockW, blockH));
  const outW = Math.max(1, Math.floor(blockW * scale));
  const outH = Math.max(1, Math.floor(blockH * scale));

  const range = meta.whiteLevel - meta.blackLevel || 1;
  const black = meta.blackLevel;

  // Black/white-level normalisation for every possible 16-bit sample. Building
  // 65536 entries once is cheaper than dividing and clamping per sample, of
  // which a full-frame preview takes several million.
  const norm = new Float32Array(65536);
  for (let raw = 0; raw < 65536; raw++) {
    const val = (raw - black) / range;
    norm[raw] = val < 0 ? 0 : val > 1 ? 1 : val;
  }

  // The strip is 16-bit samples, so when the file's byte order matches the
  // platform's (always little-endian here) and the strip is 2-byte aligned, it
  // can be read as a Uint16Array instead of through DataView. Big-endian or
  // odd-offset files keep the DataView path.
  const usableSamples = usableRows * width;
  const direct =
    little && stripOffset % 2 === 0 ? new Uint16Array(buffer, stripOffset, usableSamples) : null;
  const sampleAt = (index: number): number =>
    direct ? direct[index]! : view.getUint16(stripOffset + index * 2, little);

  // Resolve the mosaic once rather than re-testing every sample's colour inside
  // the pixel loop. Sample offsets are relative to the block's top-left sample;
  // positions are 0=(0,0) 1=(1,0) 2=(0,1) 3=(1,1). As before the last red and
  // blue position wins, and anything that is neither counts toward green.
  const positions = [0, 1, width, width + 1];
  let redOffset = -1;
  let blueOffset = -1;
  const greenOffsets: number[] = [];
  for (let k = 0; k < 4; k++) {
    if (p[k] === 0) redOffset = positions[k]!;
    else if (p[k] === 2) blueOffset = positions[k]!;
    else greenOffsets.push(positions[k]!);
  }
  const greenCount = greenOffsets.length;
  // Two greens per block is the universal case; bind them so it needs no loop.
  const green0 = greenOffsets[0] ?? 0;
  const green1 = greenOffsets[1] ?? 0;

  // Hoist the output-pixel -> block mapping; it depends only on the axis.
  const colBase = new Int32Array(outW);
  for (let ox = 0; ox < outW; ox++) {
    colBase[ox] = Math.min(blockW - 1, Math.floor((ox / outW) * blockW)) * 2;
  }
  const rowBase = new Int32Array(outH);
  for (let oy = 0; oy < outH; oy++) {
    rowBase[oy] = Math.min(blockH - 1, Math.floor((oy / outH) * blockH)) * 2 * width;
  }

  // First pass: gather linear RGB per output pixel + channel sums for WB.
  const lin = new Float32Array(outW * outH * 3);
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;

  let i = 0;
  for (let oy = 0; oy < outH; oy++) {
    const rowStart = rowBase[oy]!;
    for (let ox = 0; ox < outW; ox++) {
      const base = rowStart + colBase[ox]!;
      const r = redOffset < 0 ? 0 : norm[sampleAt(base + redOffset)]!;
      const b = blueOffset < 0 ? 0 : norm[sampleAt(base + blueOffset)]!;
      let g: number;
      if (greenCount === 2) {
        g = (norm[sampleAt(base + green0)]! + norm[sampleAt(base + green1)]!) / 2;
      } else if (greenCount === 1) {
        g = norm[sampleAt(base + green0)]!;
      } else {
        g = 0;
        for (let k = 0; k < greenCount; k++) g += norm[sampleAt(base + greenOffsets[k]!)]!;
        if (greenCount) g /= greenCount;
      }
      lin[i] = r;
      lin[i + 1] = g;
      lin[i + 2] = b;
      i += 3;
      sumR += r;
      sumG += g;
      sumB += b;
    }
  }

  // Gray-world white balance: scale R and B so their means match green's.
  let gainR = 1;
  let gainB = 1;
  if ((opts.whiteBalance ?? "grayworld") === "grayworld") {
    const n = outW * outH;
    const mR = sumR / n;
    const mG = sumG / n;
    const mB = sumB / n;
    const clamp = (x: number) => (x < 0.25 ? 0.25 : x > 4 ? 4 : x);
    if (mR > 1e-4) gainR = clamp(mG / mR);
    if (mB > 1e-4) gainB = clamp(mG / mB);
  }

  const pixels = outW * outH;
  const data = new Uint8ClampedArray(pixels * 4);
  for (let px = 0, s = 0, o = 0; px < pixels; px++, s += 3, o += 4) {
    data[o] = srgb(lin[s]! * gainR);
    data[o + 1] = srgb(lin[s + 1]!);
    data[o + 2] = srgb(lin[s + 2]! * gainB);
    data[o + 3] = 255;
  }

  return { width: outW, height: outH, data };
}
