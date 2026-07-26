/**
 * Minimal, dependency-free TIFF/DNG reader that pulls out embedded preview
 * JPEGs. DNG is a TIFF container: cameras store one or more JPEG previews in
 * IFDs — either via the JPEGInterchangeFormat / length tags (thumbnails) or as
 * a single JPEG-compressed strip (full-resolution previews). We locate those
 * byte ranges and hand back the JPEG without decoding the raw sensor data, so
 * there's no need for a (copyleft) RAW-decoding library.
 */
export interface EmbeddedJpeg {
  offset: number;
  length: number;
}

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
};

export function findEmbeddedJpegs(buffer: ArrayBuffer): EmbeddedJpeg[] {
  const view = new DataView(buffer);
  if (view.byteLength < 8) return [];

  const order = view.getUint16(0, false);
  let little: boolean;
  if (order === 0x4949)
    little = true; // "II"
  else if (order === 0x4d4d)
    little = false; // "MM"
  else return [];

  if (view.getUint16(2, little) !== 42) return [];

  const results: EmbeddedJpeg[] = [];
  const visited = new Set<number>();

  const u16 = (o: number) => view.getUint16(o, little);
  const u32 = (o: number) => view.getUint32(o, little);

  function entryValues(entryOffset: number): number[] {
    const type = u16(entryOffset + 2);
    const count = u32(entryOffset + 4);
    const size = (TYPE_SIZE[type] ?? 1) * count;
    const base = size > 4 ? u32(entryOffset + 8) : entryOffset + 8;
    const values: number[] = [];
    const step = TYPE_SIZE[type] ?? 1;
    for (let i = 0; i < count; i++) {
      const o = base + i * step;
      if (o + step > view.byteLength) break;
      if (type === 3) values.push(u16(o));
      else if (type === 4) values.push(u32(o));
      else if (type === 1 || type === 6 || type === 7) values.push(view.getUint8(o));
    }
    return values;
  }

  function pushCandidate(offset: number, length: number): void {
    if (offset <= 0 || length <= 0 || offset + length > view.byteLength) return;
    if (view.getUint16(offset, false) !== 0xffd8) return; // JPEG SOI marker
    results.push({ offset, length });
  }

  function walk(ifdOffset: number, depth: number): void {
    if (depth > 4 || ifdOffset <= 0 || ifdOffset + 2 > view.byteLength || visited.has(ifdOffset))
      return;
    visited.add(ifdOffset);

    const count = u16(ifdOffset);
    let jpegOffset = -1;
    let jpegLength = -1;
    let compression = -1;
    const blockOffsets: number[] = [];
    const blockCounts: number[] = [];
    const subIfds: number[] = [];
    let exifIfd = -1;

    for (let i = 0; i < count; i++) {
      const eo = ifdOffset + 2 + i * 12;
      if (eo + 12 > view.byteLength) break;
      const tag = u16(eo);
      const values = entryValues(eo);
      switch (tag) {
        case 0x0201:
          jpegOffset = values[0] ?? -1;
          break; // JPEGInterchangeFormat
        case 0x0202:
          jpegLength = values[0] ?? -1;
          break; // JPEGInterchangeFormatLength
        case 0x0103:
          compression = values[0] ?? -1;
          break; // Compression
        case 0x0111:
          blockOffsets.push(...values);
          break; // StripOffsets
        case 0x0117:
          blockCounts.push(...values);
          break; // StripByteCounts
        case 0x0144:
          blockOffsets.push(...values);
          break; // TileOffsets
        case 0x0145:
          blockCounts.push(...values);
          break; // TileByteCounts
        case 0x014a:
          subIfds.push(...values);
          break; // SubIFDs
        case 0x8769:
          exifIfd = values[0] ?? -1;
          break; // ExifIFD
      }
    }

    if (jpegOffset > 0 && jpegLength > 0) pushCandidate(jpegOffset, jpegLength);
    // A JPEG-compressed preview stored as a single strip or tile
    if (
      (compression === 6 || compression === 7) &&
      blockOffsets.length === 1 &&
      blockCounts.length === 1
    ) {
      pushCandidate(blockOffsets[0]!, blockCounts[0]!);
    }

    for (const sub of subIfds) walk(sub, depth + 1);
    if (exifIfd > 0) walk(exifIfd, depth + 1);
    walk(u32(ifdOffset + 2 + count * 12), depth + 1); // next IFD
  }

  walk(u32(4), 0);
  return results;
}

/**
 * Extract an embedded preview JPEG from a DNG buffer as an image/jpeg Blob.
 * `prefer` picks the largest embedded JPEG (a full preview) or the smallest
 * (a lightweight thumbnail). Returns null when no preview is present.
 */
export function extractDngPreview(
  buffer: ArrayBuffer,
  prefer: "largest" | "smallest" = "largest",
): Blob | null {
  const jpegs = findEmbeddedJpegs(buffer);
  if (jpegs.length === 0) return null;
  jpegs.sort((a, b) => (prefer === "largest" ? b.length - a.length : a.length - b.length));
  const best = jpegs[0]!;
  return new Blob([new Uint8Array(buffer, best.offset, best.length)], { type: "image/jpeg" });
}
