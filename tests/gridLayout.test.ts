import { describe, expect, it } from "vitest";
import {
  bandIntersects,
  computeGridLayout,
  gridColumns,
  GROUP_GAP,
  GROUP_HEADER_HEIGHT,
  TILE_GAP,
  visibleRows,
} from "~/utils/gridLayout";

const groups = (...counts: number[]) => counts.map((count, i) => ({ key: `d${i}`, count }));

describe("gridColumns", () => {
  /**
   * The virtualizer only looks right if it picks the same column count CSS
   * would have. `repeat(auto-fill, minmax(164px, 1fr))` with an 8px gap fits n
   * tracks while n*164 + (n-1)*8 <= width.
   */
  it("matches what auto-fill would resolve to", () => {
    expect(gridColumns(164, 164)).toBe(1);
    expect(gridColumns(335, 164)).toBe(1); // 2 tracks need 336
    expect(gridColumns(336, 164)).toBe(2);
    expect(gridColumns(507, 164)).toBe(2); // 3 tracks need 508
    expect(gridColumns(508, 164)).toBe(3);
  });

  it("never drops below one column, however narrow", () => {
    expect(gridColumns(40, 164)).toBe(1);
    expect(gridColumns(0, 164)).toBe(1);
    expect(gridColumns(-10, 164)).toBe(1);
  });
});

describe("computeGridLayout", () => {
  it("splits the leftover width evenly, exactly as 1fr tracks do", () => {
    // 3 columns in 508px leaves 508 - 2*8 = 492 for tiles.
    const layout = computeGridLayout(groups(1), 508, 164);
    expect(layout.columns).toBe(3);
    expect(layout.tileSize).toBeCloseTo(164);
    expect(layout.rowPitch).toBeCloseTo(172);
  });

  it("stacks sections with a header and an inter-section gap", () => {
    const layout = computeGridLayout(groups(3, 3), 508, 164);
    const [first, second] = layout.bands;
    expect(first!.top).toBe(0);
    // One row of 3 tiles: header + a single tile, no inter-row gap.
    expect(first!.height).toBeCloseTo(GROUP_HEADER_HEIGHT + layout.tileSize);
    expect(second!.top).toBeCloseTo(first!.height + GROUP_GAP);
  });

  it("wraps items onto the right number of rows", () => {
    const layout = computeGridLayout(groups(7), 508, 164); // 3 columns
    expect(layout.bands[0]!.rows).toBe(3);
    expect(layout.bands[0]!.height).toBeCloseTo(
      GROUP_HEADER_HEIGHT + 3 * layout.tileSize + 2 * TILE_GAP,
    );
  });

  it("omits the trailing gap so the last section sets the total height", () => {
    const layout = computeGridLayout(groups(1, 1), 508, 164);
    const last = layout.bands[1]!;
    expect(layout.totalHeight).toBeCloseTo(last.top + last.height);
  });

  it("handles an empty library and an empty day", () => {
    expect(computeGridLayout([], 508, 164).totalHeight).toBe(0);
    const layout = computeGridLayout(groups(0), 508, 164);
    expect(layout.bands[0]!.rows).toBe(0);
    // An empty day still occupies its header.
    expect(layout.bands[0]!.height).toBe(GROUP_HEADER_HEIGHT);
  });

  it("reports a zero tile size before the container has been measured", () => {
    const layout = computeGridLayout(groups(4), 0, 164);
    expect(layout.tileSize).toBe(0);
    expect(Number.isFinite(layout.totalHeight)).toBe(true);
  });
});

describe("visibleRows", () => {
  const layout = computeGridLayout(groups(100), 508, 164); // 3 columns, 34 rows
  const band = layout.bands[0]!;
  const pitch = layout.rowPitch;

  it("selects only the rows crossing the window", () => {
    const tilesTop = band.top + band.tilesTop;
    // A window covering exactly rows 2 and 3.
    const range = visibleRows(band, pitch, tilesTop + 2 * pitch, tilesTop + 3 * pitch + 1);
    expect(range).toEqual({ first: 2, last: 3 });
  });

  it("clamps to the rows that exist rather than running past the end", () => {
    const range = visibleRows(band, pitch, -10_000, 10_000_000)!;
    expect(range.first).toBe(0);
    expect(range.last).toBe(band.rows - 1);
  });

  it("returns null when the tiles sit entirely outside the window", () => {
    const tilesTop = band.top + band.tilesTop;
    expect(visibleRows(band, pitch, tilesTop - 500, tilesTop - 100)).toBeNull();
    const past = tilesTop + band.rows * pitch + 100;
    expect(visibleRows(band, pitch, past, past + 500)).toBeNull();
  });

  it("returns null for a day with no tiles", () => {
    const empty = computeGridLayout(groups(0), 508, 164);
    expect(visibleRows(empty.bands[0]!, empty.rowPitch, 0, 1000)).toBeNull();
  });

  /**
   * Every tile must be reachable: sweeping a viewport down the whole grid has
   * to yield each row at least once, or files silently vanish mid-scroll.
   */
  it("covers every row as a viewport sweeps the grid", () => {
    const viewport = 700;
    const seen = new Set<number>();
    for (let top = -viewport; top <= layout.totalHeight + viewport; top += 50) {
      const range = visibleRows(band, pitch, top, top + viewport);
      if (!range) continue;
      for (let r = range.first; r <= range.last; r++) seen.add(r);
    }
    expect(seen.size).toBe(band.rows);
  });
});

describe("bandIntersects", () => {
  const layout = computeGridLayout(groups(3, 3, 3), 508, 164);

  it("keeps a section whose header is visible but whose tiles are not", () => {
    const band = layout.bands[1]!;
    expect(bandIntersects(band, band.top - 5, band.top + 5)).toBe(true);
  });

  it("drops sections fully above or below the window", () => {
    const band = layout.bands[0]!;
    expect(bandIntersects(band, band.top + band.height + 1, 99_999)).toBe(false);
    expect(bandIntersects(layout.bands[2]!, -99_999, -1)).toBe(false);
  });
});
