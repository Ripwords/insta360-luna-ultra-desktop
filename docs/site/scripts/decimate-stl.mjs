import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The layer's `public/Insta360+LunaUltra.stl` (repo root) is the official
// hi-fi scan at ~58 MB — far too large to serve to a web visitor, which is
// why `strip-desktop-assets.mjs` deletes the inherited copy from the docs
// build's output. This script produces a much smaller stand-in via vertex
// clustering and writes it to this app's own `public/`, where Nuxt's
// layer-merge rules mean it wins over the inherited original (a project's
// own `public/` takes precedence over an extended layer's).
//
// Binary STL needs no parsing library: an 80-byte header, a `uint32`
// triangle count, then 50 bytes per triangle — a 3-float facet normal, three
// 3-float vertices (36 bytes), and a 2-byte "attribute byte count" that's
// always zero for geometry-only scans like this one.
const HEADER_SIZE = 80;
const TRIANGLE_SIZE = 50;

const here = dirname(fileURLToPath(import.meta.url));
const inputPath = resolve(here, "../../../public/Insta360+LunaUltra.stl");
const outputPath = resolve(here, "../public/Insta360+LunaUltra.stl");

// Land comfortably under ~4 MB. Each output triangle costs 50 bytes, so this
// is a triangle-count budget as much as a byte one.
const TARGET_BYTES = 4 * 1024 * 1024;

/** @typedef {{ vertices: [number, number, number][] }} Triangle */

/** @returns {Triangle[]} */
function readTriangles(buffer) {
  const triCount = buffer.readUInt32LE(HEADER_SIZE);
  /** @type {Triangle[]} */
  const triangles = [];
  let offset = HEADER_SIZE + 4;
  for (let i = 0; i < triCount; i++) {
    // Skip the 12-byte facet normal (bytes 0-11 of the record) — it's
    // recomputed from the (possibly snapped) vertices on the way out.
    const vertices = [0, 1, 2].map((v) => {
      const vOffset = offset + 12 + v * 12;
      return /** @type {[number, number, number]} */ ([
        buffer.readFloatLE(vOffset),
        buffer.readFloatLE(vOffset + 4),
        buffer.readFloatLE(vOffset + 8),
      ]);
    });
    triangles.push({ vertices });
    offset += TRIANGLE_SIZE;
  }
  return triangles;
}

function boundingBox(triangles) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const tri of triangles) {
    for (const v of tri.vertices) {
      for (let axis = 0; axis < 3; axis++) {
        if (v[axis] < min[axis]) min[axis] = v[axis];
        if (v[axis] > max[axis]) max[axis] = v[axis];
      }
    }
  }
  return { min, max };
}

/**
 * Vertex clustering: snap every vertex to the nearest cell of a uniform grid
 * spanning the model's bounding box, drop triangles that collapse to a
 * degenerate sliver once two or more of their corners land in the same cell,
 * and deduplicate any triangles left identical by the snap. Reduces both
 * vertex count (many original vertices collapse onto one grid point) and
 * triangle count (degenerate/duplicate removal), which is what actually
 * shrinks the file — the format has no other compression to give.
 */
function decimate(triangles, gridResolution, { min, max }) {
  const size = [0, 1, 2].map((axis) => max[axis] - min[axis]);
  // A flat axis (extent 0) would divide by zero; treat it as a single cell.
  const cellSize = size.map((s) => (s > 0 ? s / gridResolution : 1));

  function snap(vertex) {
    const cell = [0, 1, 2].map((axis) => Math.round((vertex[axis] - min[axis]) / cellSize[axis]));
    const position = cell.map((c, axis) => min[axis] + c * cellSize[axis]);
    return { position, key: cell.join(",") };
  }

  const seen = new Set();
  const output = [];

  for (const tri of triangles) {
    const snapped = tri.vertices.map(snap);
    const keys = snapped.map((s) => s.key);
    const degenerate = keys[0] === keys[1] || keys[1] === keys[2] || keys[0] === keys[2];
    if (degenerate) continue;

    // Order-independent: a triangle wound the other way around the same
    // three cells is still the same triangle for this purpose.
    const dedupeKey = [...keys].sort().join("|");
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    output.push({ vertices: snapped.map((s) => s.position) });
  }

  return output;
}

function faceNormal([a, b, c]) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const cross = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  const length = Math.hypot(...cross);
  return length === 0 ? [0, 0, 0] : cross.map((n) => n / length);
}

function writeBinarySTL(triangles) {
  const buffer = Buffer.alloc(HEADER_SIZE + 4 + triangles.length * TRIANGLE_SIZE);
  buffer.write("Decimated Insta360 Luna Ultra scan (vertex-clustered)", 0, "ascii");
  buffer.writeUInt32LE(triangles.length, HEADER_SIZE);

  let offset = HEADER_SIZE + 4;
  for (const tri of triangles) {
    const normal = faceNormal(tri.vertices);
    buffer.writeFloatLE(normal[0], offset);
    buffer.writeFloatLE(normal[1], offset + 4);
    buffer.writeFloatLE(normal[2], offset + 8);
    for (let v = 0; v < 3; v++) {
      const vOffset = offset + 12 + v * 12;
      buffer.writeFloatLE(tri.vertices[v][0], vOffset);
      buffer.writeFloatLE(tri.vertices[v][1], vOffset + 4);
      buffer.writeFloatLE(tri.vertices[v][2], vOffset + 8);
    }
    buffer.writeUInt16LE(0, offset + 48);
    offset += TRIANGLE_SIZE;
  }
  return buffer;
}

const input = await readFile(inputPath);
const triangles = readTriangles(input);
const bounds = boundingBox(triangles);
console.log(
  `[decimate-stl] input: ${triangles.length} triangles, ${(input.length / 1024 / 1024).toFixed(1)} MB`,
);

// Start coarse-ish and refine upward would overshoot the budget in one step;
// instead start fine (512^3, per the brief) and coarsen until under budget.
let resolution = 512;
let output = null;
let outTriangles = [];
while (resolution >= 16) {
  outTriangles = decimate(triangles, resolution, bounds);
  output = writeBinarySTL(outTriangles);
  console.log(
    `[decimate-stl] grid ${resolution}^3 -> ${outTriangles.length} triangles, ${(output.length / 1024 / 1024).toFixed(2)} MB`,
  );
  if (output.length <= TARGET_BYTES) break;
  resolution = Math.floor(resolution * 0.92);
}

if (!output) throw new Error("decimation produced no output");

await writeFile(outputPath, output);
console.log(
  `[decimate-stl] wrote ${outputPath}\n[decimate-stl] triangles: ${triangles.length} -> ${outTriangles.length}, size: ${(input.length / 1024 / 1024).toFixed(1)} MB -> ${(output.length / 1024 / 1024).toFixed(2)} MB`,
);
