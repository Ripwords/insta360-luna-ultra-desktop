/**
 * Histogram maths for the live viewfinder. Pure and DOM-free on purpose: the
 * only thing that may touch a `VideoFrame` is the decode surface, and keeping
 * the arithmetic out here is what makes it testable without WebCodecs.
 */

/** One bin per 8-bit code value, so a bin index *is* the sample value. */
export const HISTOGRAM_BINS = 256;

/**
 * Sample at a third of the ~30fps preview. A histogram redrawing thirty times
 * a second is a shimmer rather than a reading, and no scene changes shape fast
 * enough to be worth the pixel reads.
 */
export const HISTOGRAM_SAMPLE_EVERY = 3;

/** Sample grid: small enough to read every frame, dense enough to hold a shape. */
export const HISTOGRAM_SAMPLE_WIDTH = 128;
export const HISTOGRAM_SAMPLE_HEIGHT = 96;

export const HISTOGRAM_MODES = ["off", "luma", "rgb"] as const;
export type HistogramMode = (typeof HISTOGRAM_MODES)[number];

export interface Histogram {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  luma: Uint32Array;
  /** Pixels sampled. Zero when there is nothing to show yet. */
  total: number;
  /** Tallest bin across every channel, so the renderer can scale in one read. */
  peak: number;
  /** Share of pixels with any channel at 0, as a fraction of `total`. */
  clippedShadows: number;
  /** Share of pixels with any channel at 255, as a fraction of `total`. */
  clippedHighlights: number;
}

/**
 * Rec.709 luma coefficients. The preview is HD video, so this is the transfer
 * it is actually encoded in — a flat (r+g+b)/3 would read greens as far darker
 * and reds as far brighter than they expose, which is the one error an
 * exposure tool must not make.
 */
const R_WEIGHT = 0.2126;
const G_WEIGHT = 0.7152;
const B_WEIGHT = 0.0722;

export function emptyHistogram(): Histogram {
  return {
    r: new Uint32Array(HISTOGRAM_BINS),
    g: new Uint32Array(HISTOGRAM_BINS),
    b: new Uint32Array(HISTOGRAM_BINS),
    luma: new Uint32Array(HISTOGRAM_BINS),
    total: 0,
    peak: 0,
    clippedShadows: 0,
    clippedHighlights: 0,
  };
}

/**
 * Bin an RGBA buffer — the layout `CanvasRenderingContext2D.getImageData`
 * returns. Alpha is ignored: the preview is opaque, and a frame is not less
 * exposed for being drawn translucent.
 */
export function computeHistogram(rgba: Uint8ClampedArray): Histogram {
  const result = emptyHistogram();
  const { r, g, b, luma } = result;

  let total = 0;
  let shadows = 0;
  let highlights = 0;

  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const red = rgba[i]!;
    const green = rgba[i + 1]!;
    const blue = rgba[i + 2]!;

    r[red]!++;
    g[green]!++;
    b[blue]!++;
    luma[Math.round(R_WEIGHT * red + G_WEIGHT * green + B_WEIGHT * blue)]!++;

    // Any channel at a rail is clipped. Testing per channel rather than on
    // luma is deliberate: a blown red on an otherwise mid-grey pixel is the
    // failure you most need to see, and it never reaches 255 in luma.
    if (red === 0 || green === 0 || blue === 0) shadows++;
    if (red === 255 || green === 255 || blue === 255) highlights++;
    total++;
  }

  let peak = 0;
  for (let bin = 0; bin < HISTOGRAM_BINS; bin++) {
    if (r[bin]! > peak) peak = r[bin]!;
    if (g[bin]! > peak) peak = g[bin]!;
    if (b[bin]! > peak) peak = b[bin]!;
    if (luma[bin]! > peak) peak = luma[bin]!;
  }

  result.total = total;
  result.peak = peak;
  result.clippedShadows = total === 0 ? 0 : shadows / total;
  result.clippedHighlights = total === 0 ? 0 : highlights / total;
  return result;
}

/** off → luma → rgb → off. One control, in the order you reach for them. */
export function cycleHistogramMode(mode: HistogramMode): HistogramMode {
  const next = HISTOGRAM_MODES.indexOf(mode) + 1;
  return HISTOGRAM_MODES[next % HISTOGRAM_MODES.length]!;
}
