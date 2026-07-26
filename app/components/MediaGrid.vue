<script setup lang="ts">
import type { MediaItem } from "~/types/media";
import { bandIntersects, computeGridLayout, TILE_GAP, visibleRows } from "~/utils/gridLayout";

/**
 * Day-grouped media grid that only mounts the tiles near the viewport.
 *
 * A camera card can hold thousands of files, and every `MediaTile` carries a
 * nested image component with its own IntersectionObserver — so rendering the
 * whole library cost two observers and a component tree per file before a
 * single thumbnail was wanted. Tiles are positioned from computed coordinates
 * rather than by CSS grid, which is what makes it possible to skip the ones
 * out of view; `~/utils/gridLayout` reproduces the auto-fill maths so the
 * result is pixel-identical to the grid it replaces.
 *
 * Sections and headings stay in the DOM as real `<section>`/`<h2>` elements,
 * and tiles keep their `item.id` as the v-for key, so scrolling a tile out and
 * back reuses its component (and its cached blob) instead of re-fetching.
 */
const { groups, tileMin, selected, selectionActive } = defineProps<{
  groups: Array<{ key: string; label: string; items: MediaItem[] }>;
  tileMin: number;
  selected: Set<string>;
  selectionActive: boolean;
}>();

const emit = defineEmits<{
  open: [item: MediaItem];
  select: [item: MediaItem, event: MouseEvent];
  loaded: [item: MediaItem, dimensions: { width: number; height: number }];
  selectGroup: [ids: string[]];
}>();

/**
 * How far beyond the viewport to keep tiles mounted. Comfortably more than the
 * 300px `rootMargin` the image components use to begin fetching, so a tile is
 * always mounted before it is close enough to want its bytes.
 */
const OVERSCAN = 600;

const root = useTemplateRef<HTMLElement>("root");
const width = ref(0);
const scrollTop = ref(0);
const viewportHeight = ref(0);
/** Distance from the scroller's content origin to the top of this grid. */
const gridOffset = ref(0);

const layout = computed(() =>
  computeGridLayout(
    groups.map((group) => ({ key: group.key, count: group.items.length })),
    width.value,
    tileMin,
  ),
);

/** The sections to render, each with just the tiles inside the current window. */
const visible = computed(() => {
  const { bands, columns, tileSize, rowPitch } = layout.value;
  const from = scrollTop.value - gridOffset.value - OVERSCAN;
  const to = from + viewportHeight.value + OVERSCAN * 2;

  const sections = [];
  for (const band of bands) {
    if (!bandIntersects(band, from, to)) continue;
    const group = groups[band.index];
    if (!group) continue;

    const tiles: Array<{ item: MediaItem; x: number; y: number }> = [];
    const rows = visibleRows(band, rowPitch, from, to);
    if (rows) {
      for (let row = rows.first; row <= rows.last; row++) {
        for (let column = 0; column < columns; column++) {
          const item = group.items[row * columns + column];
          if (!item) break;
          tiles.push({ item, x: column * (tileSize + TILE_GAP), y: row * rowPitch });
        }
      }
    }
    sections.push({ band, group, tiles });
  }
  return sections;
});

let scroller: HTMLElement | null = null;
let observer: ResizeObserver | null = null;
let pending = 0;

/**
 * The grid does not own its scrollbar — the dashboard panel body does — so walk
 * up to whichever ancestor actually scrolls rather than hard-coding that
 * relationship. Falls back to the document for any layout that changes.
 */
function findScroller(element: HTMLElement): HTMLElement {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

/** Re-read every geometry input at once, so scrolling itself stays arithmetic. */
function measure() {
  const element = root.value;
  if (!element || !scroller) return;
  width.value = element.clientWidth;
  viewportHeight.value = scroller.clientHeight;
  gridOffset.value =
    element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  scrollTop.value = scroller.scrollTop;
}

function onScroll() {
  // Coalesce to one read per frame: the scroller can fire far faster than that.
  if (pending || !scroller) return;
  pending = requestAnimationFrame(() => {
    pending = 0;
    if (scroller) scrollTop.value = scroller.scrollTop;
  });
}

onMounted(async () => {
  await nextTick();
  const element = root.value;
  if (!element) return;
  scroller = findScroller(element);
  scroller.addEventListener("scroll", onScroll, { passive: true });
  // Watch both: the grid's width sets the columns, the scroller's height sets
  // how many rows are in view, and the toolbar above can change our offset.
  observer = new ResizeObserver(measure);
  observer.observe(element);
  observer.observe(scroller);
  measure();
});

onBeforeUnmount(() => {
  cancelAnimationFrame(pending);
  observer?.disconnect();
  scroller?.removeEventListener("scroll", onScroll);
  scroller = null;
});
</script>

<template>
  <div ref="root" class="relative" :style="{ height: `${layout.totalHeight}px` }">
    <section
      v-for="section in visible"
      :key="section.band.key"
      class="absolute inset-x-0"
      :style="{ top: `${section.band.top}px`, height: `${section.band.height}px` }"
      :aria-label="section.group.label"
    >
      <!-- h-7 is load-bearing: gridLayout assumes this exact header height. -->
      <div class="mb-2.5 flex h-7 items-baseline gap-3">
        <h2 class="text-sm font-semibold text-highlighted">{{ section.group.label }}</h2>
        <span class="font-mono text-xs text-muted tabular-nums">
          {{ section.group.items.length }}
        </span>
        <UButton
          :label="
            section.group.items.every((i) => selected.has(i.id)) ? 'Deselect day' : 'Select day'
          "
          size="xs"
          color="neutral"
          variant="ghost"
          @click="
            emit(
              'selectGroup',
              section.group.items.map((i) => i.id),
            )
          "
        />
      </div>

      <div class="relative">
        <div
          v-for="tile in section.tiles"
          :key="tile.item.id"
          class="absolute left-0 top-0"
          :style="{
            transform: `translate3d(${tile.x}px, ${tile.y}px, 0)`,
            width: `${layout.tileSize}px`,
            height: `${layout.tileSize}px`,
          }"
        >
          <MediaTile
            :item="tile.item"
            :selected="selected.has(tile.item.id)"
            :selection-active="selectionActive"
            @open="emit('open', tile.item)"
            @select="emit('select', tile.item, $event)"
            @loaded="emit('loaded', tile.item, $event)"
          />
        </div>
      </div>
    </section>
  </div>
</template>
