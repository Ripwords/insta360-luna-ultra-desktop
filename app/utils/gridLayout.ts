/**
 * Layout maths for the virtualized gallery grid.
 *
 * The gallery used to hand every file to the DOM at once — two
 * IntersectionObservers per tile — which is the wrong shape for a camera card
 * holding thousands of shots. Virtualizing means computing, rather than letting
 * CSS discover, where each tile lands: this module reproduces exactly what
 * `grid-template-columns: repeat(auto-fill, minmax(<tileMin>, 1fr))` would have
 * done, so the visible result is unchanged.
 *
 * Kept free of DOM access so the arithmetic is testable without a browser.
 */

/** Tailwind `gap-2` between tiles. */
export const TILE_GAP = 8;
/** Tailwind `space-y-8` between day sections. */
export const GROUP_GAP = 32;
/**
 * A day header's `h-7` row plus its `mb-2.5`. Fixed rather than measured so a
 * section's height is known before it renders; the markup pins the same height.
 */
export const GROUP_HEADER_HEIGHT = 38;

export interface LayoutGroup {
  key: string;
  count: number;
}

export interface GroupBand {
  key: string;
  /** Index into the source group list. */
  index: number;
  /** Offset of the section from the top of the grid container. */
  top: number;
  /** Header plus every tile row. */
  height: number;
  /** Offset of the tile area from the top of its section. */
  tilesTop: number;
  rows: number;
}

export interface GridLayout {
  columns: number;
  tileSize: number;
  /** Distance between the top edges of two consecutive rows. */
  rowPitch: number;
  bands: GroupBand[];
  totalHeight: number;
}

/**
 * The column count `repeat(auto-fill, minmax(tileMin, 1fr))` resolves to: the
 * most tracks of at least `tileMin` that fit once the gaps between them are
 * paid for. Always at least one, so a container narrower than one tile still
 * renders a (squashed) column rather than dividing by zero.
 */
export function gridColumns(containerWidth: number, tileMin: number, gap = TILE_GAP): number {
  if (containerWidth <= 0 || tileMin <= 0) return 1;
  return Math.max(1, Math.floor((containerWidth + gap) / (tileMin + gap)));
}

/** Place every day section and work out the total scrollable height. */
export function computeGridLayout(
  groups: LayoutGroup[],
  containerWidth: number,
  tileMin: number,
  gap = TILE_GAP,
): GridLayout {
  const columns = gridColumns(containerWidth, tileMin, gap);
  // `1fr` tracks split whatever the gaps leave behind, evenly.
  const tileSize = containerWidth > 0 ? (containerWidth - gap * (columns - 1)) / columns : 0;
  const bands: GroupBand[] = [];
  let cursor = 0;

  groups.forEach((group, index) => {
    const rows = Math.ceil(Math.max(0, group.count) / columns);
    const tilesHeight = rows > 0 ? rows * tileSize + (rows - 1) * gap : 0;
    const height = GROUP_HEADER_HEIGHT + tilesHeight;
    bands.push({
      key: group.key,
      index,
      top: cursor,
      height,
      tilesTop: GROUP_HEADER_HEIGHT,
      rows,
    });
    cursor += height + GROUP_GAP;
  });

  // The gap sits *between* sections, so the last one does not contribute it.
  const totalHeight = groups.length > 0 ? cursor - GROUP_GAP : 0;
  return { columns, tileSize, rowPitch: tileSize + gap, bands, totalHeight };
}

/** Whether any part of a section falls inside the band [from, to]. */
export function bandIntersects(band: GroupBand, from: number, to: number): boolean {
  return band.top + band.height >= from && band.top <= to;
}

/**
 * The inclusive row range of a section intersecting [from, to], both given in
 * container coordinates. Returns null when the section contributes no rows —
 * an empty day, or one whose tiles sit entirely outside the window even though
 * its header does not.
 */
export function visibleRows(
  band: GroupBand,
  rowPitch: number,
  from: number,
  to: number,
): { first: number; last: number } | null {
  if (band.rows === 0 || rowPitch <= 0) return null;
  const tilesTop = band.top + band.tilesTop;
  const relativeFrom = from - tilesTop;
  const relativeTo = to - tilesTop;
  if (relativeTo < 0 || relativeFrom > band.rows * rowPitch) return null;
  const first = Math.max(0, Math.floor(relativeFrom / rowPitch));
  const last = Math.min(band.rows - 1, Math.floor(relativeTo / rowPitch));
  return last < first ? null : { first, last };
}
