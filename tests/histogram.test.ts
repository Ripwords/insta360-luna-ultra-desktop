import { describe, expect, it } from "vitest";
import {
  computeHistogram,
  cycleHistogramMode,
  HISTOGRAM_BINS,
  type HistogramMode,
} from "~/utils/histogram";

/** Build an RGBA buffer from a flat list of [r, g, b] triples. */
const pixels = (...triples: [number, number, number][]) =>
  new Uint8ClampedArray(triples.flatMap(([r, g, b]) => [r, g, b, 255]));

/** Every bin that holds a non-zero count, as [bin, count] pairs. */
const occupied = (bins: Uint32Array) =>
  [...bins.entries()].filter(([, count]) => count > 0).map(([bin, count]) => [bin, count]);

describe("computeHistogram", () => {
  it("counts each channel into its own 256-bin array", () => {
    const result = computeHistogram(pixels([10, 20, 30], [10, 200, 30]));

    expect(result.r).toHaveLength(HISTOGRAM_BINS);
    expect(occupied(result.r)).toEqual([[10, 2]]);
    expect(occupied(result.g)).toEqual([
      [20, 1],
      [200, 1],
    ]);
    expect(occupied(result.b)).toEqual([[30, 2]]);
  });

  /**
   * A flat (r+g+b)/3 average reads green as too dark and red as too bright,
   * which is exactly the error that makes you misjudge an exposure. Rec.709 is
   * the transfer the preview is actually encoded in.
   */
  it("weights luma by Rec.709 rather than averaging the channels", () => {
    const green = computeHistogram(pixels([0, 255, 0]));
    const red = computeHistogram(pixels([255, 0, 0]));
    const blue = computeHistogram(pixels([0, 0, 255]));

    expect(occupied(green.luma)).toEqual([[Math.round(0.7152 * 255), 1]]);
    expect(occupied(red.luma)).toEqual([[Math.round(0.2126 * 255), 1]]);
    expect(occupied(blue.luma)).toEqual([[Math.round(0.0722 * 255), 1]]);
  });

  it("puts pure black in bin 0 and pure white in bin 255", () => {
    const result = computeHistogram(pixels([0, 0, 0], [255, 255, 255]));

    expect(result.luma[0]).toBe(1);
    expect(result.luma[HISTOGRAM_BINS - 1]).toBe(1);
  });

  it("reports clipping as a fraction of the sample, per end of the range", () => {
    // 1 crushed, 3 blown, 4 mid-grey — of 8 total.
    const result = computeHistogram(
      pixels(
        [0, 0, 0],
        [255, 255, 255],
        [255, 255, 255],
        [255, 255, 255],
        [128, 128, 128],
        [128, 128, 128],
        [128, 128, 128],
        [128, 128, 128],
      ),
    );

    expect(result.clippedShadows).toBeCloseTo(1 / 8);
    expect(result.clippedHighlights).toBeCloseTo(3 / 8);
  });

  /**
   * A single blown channel is still blown — it is the case you most need to
   * catch, and averaging into luma first would hide it.
   */
  it("counts a pixel as clipped when any single channel is at the rail", () => {
    const result = computeHistogram(pixels([255, 10, 10], [10, 10, 0]));

    expect(result.clippedHighlights).toBeCloseTo(1 / 2);
    expect(result.clippedShadows).toBeCloseTo(1 / 2);
  });

  it("returns an all-zero histogram for an empty sample without dividing by zero", () => {
    const result = computeHistogram(new Uint8ClampedArray(0));

    expect(result.total).toBe(0);
    expect(result.peak).toBe(0);
    expect(result.clippedShadows).toBe(0);
    expect(result.clippedHighlights).toBe(0);
    expect(occupied(result.luma)).toEqual([]);
  });

  /**
   * The renderer scales bar heights against `peak`. Taking it from the counts
   * here keeps that a read rather than a second pass over 256 bins per frame.
   */
  it("reports the tallest bin across every channel it will draw", () => {
    const result = computeHistogram(pixels([10, 20, 30], [10, 20, 40], [10, 99, 50]));

    expect(result.total).toBe(3);
    expect(result.peak).toBe(3); // red: three pixels share bin 10
  });

  it("ignores the alpha byte", () => {
    const opaque = computeHistogram(new Uint8ClampedArray([10, 20, 30, 255]));
    const transparent = computeHistogram(new Uint8ClampedArray([10, 20, 30, 0]));

    expect(occupied(opaque.luma)).toEqual(occupied(transparent.luma));
  });
});

describe("cycleHistogramMode", () => {
  it("steps off to luma to rgb and back to off", () => {
    const seen: HistogramMode[] = [];
    let mode: HistogramMode = "off";
    for (let i = 0; i < 4; i++) {
      mode = cycleHistogramMode(mode);
      seen.push(mode);
    }

    expect(seen).toEqual(["luma", "rgb", "off", "luma"]);
  });
});
