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

  // First pass: gather linear RGB per output pixel + channel sums for WB.
  const lin = new Float32Array(outW * outH * 3);
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  const sample = (x: number, y: number): number => {
    const o = stripOffset + (y * width + x) * 2;
    return little ? view.getUint16(o, true) : view.getUint16(o, false);
  };
  const norm = (raw: number): number => {
    const val = (raw - black) / range;
    return val < 0 ? 0 : val > 1 ? 1 : val;
  };

  for (let oy = 0; oy < outH; oy++) {
    const by = Math.min(blockH - 1, Math.floor((oy / outH) * blockH));
    const y0 = by * 2;
    for (let ox = 0; ox < outW; ox++) {
      const bx = Math.min(blockW - 1, Math.floor((ox / outW) * blockW));
      const x0 = bx * 2;
      // Four CFA samples of this block, positions: 0=(0,0) 1=(0,1) 2=(1,0) 3=(1,1)
      const s = [sample(x0, y0), sample(x0 + 1, y0), sample(x0, y0 + 1), sample(x0 + 1, y0 + 1)];
      let r = 0;
      let g = 0;
      let gN = 0;
      let b = 0;
      for (let k = 0; k < 4; k++) {
        const c = p[k];
        const val = norm(s[k]!);
        if (c === 0) r = val;
        else if (c === 2) b = val;
        else {
          g += val;
          gN++;
        }
      }
      g = gN ? g / gN : g;
      const i = (oy * outW + ox) * 3;
      lin[i] = r;
      lin[i + 1] = g;
      lin[i + 2] = b;
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

  const data = new Uint8ClampedArray(outW * outH * 4);
  for (let px = 0; px < outW * outH; px++) {
    const i = px * 3;
    const o = px * 4;
    data[o] = encodeSrgb(lin[i]! * gainR);
    data[o + 1] = encodeSrgb(lin[i + 1]!);
    data[o + 2] = encodeSrgb(lin[i + 2]! * gainB);
    data[o + 3] = 255;
  }

  return { width: outW, height: outH, data };
}
