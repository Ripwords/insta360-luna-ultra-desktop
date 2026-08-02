/**
 * Session-lifetime LRU cache for camera media.
 *
 * Every media component fetches from the camera on its own IntersectionObserver
 * and drops the result on unmount, so scrolling a tile out of the grid and back
 * re-downloads it over the camera's slow Wi-Fi — and opening full-screen
 * re-fetches a file the grid already pulled. This cache keeps the *derived*
 * artifact (a display-ready Blob, or a decoded RAW data URL) keyed by source, so
 * a repeat view costs no network and no camera-queue slot.
 *
 * Deliberately memory-only: it is empty on app start. The multi-MB source
 * buffer behind a RAW is never cached, only the small preview derived from it.
 *
 * Eviction is by recency, not frequency. Gallery access is scroll-driven, so a
 * tile just scrolled past is far likelier to return than one viewed ten times
 * earlier; frequency counting would also let early views pin entries forever.
 *
 * Evicting an entry can never blank a rendered <img>: an object URL keeps its
 * blob alive independently of this cache's reference.
 */

/** Anything the cache can size and hold: a binary blob or a data URL string. */
export type CachedMedia = Blob | string;

export interface MediaCache {
  /**
   * Resolve `key`, running `load` only on a miss. Concurrent calls for one key
   * share a single `load`. A `null` result is cached (the source can never
   * produce a preview); a rejection is not (camera Wi-Fi failures are
   * transient and must stay retryable).
   */
  get<T extends CachedMedia>(key: string, load: () => Promise<T | null>): Promise<T | null>;
  /** Whether a resolved entry is held. Does not count in-flight loads. */
  has(key: string): boolean;
  /** Total tracked bytes currently held. */
  bytes(): number;
  clear(): void;
}

function sizeOf(value: CachedMedia | null): number {
  if (value === null) return 0;
  // A cached `null` still deserves an entry, but costs nothing to keep.
  return typeof value === "string" ? value.length : value.size;
}

export function createMediaCache(budgetBytes: number): MediaCache {
  // Map iteration order is insertion order, so re-inserting on read gives us
  // least-recently-used at the front and most-recently-used at the back.
  const entries = new Map<string, { value: CachedMedia | null; bytes: number }>();
  const inFlight = new Map<string, Promise<CachedMedia | null>>();
  let total = 0;

  function evict(): void {
    // Stop at one entry: a single item larger than the whole budget is still
    // worth keeping — dropping it would mean it can never be cached at all.
    while (total > budgetBytes && entries.size > 1) {
      const oldest = entries.keys().next();
      if (oldest.done) return;
      const entry = entries.get(oldest.value)!;
      entries.delete(oldest.value);
      total -= entry.bytes;
    }
  }

  return {
    get<T extends CachedMedia>(key: string, load: () => Promise<T | null>): Promise<T | null> {
      const hit = entries.get(key);
      if (hit) {
        // Re-insert to mark most-recently-used.
        entries.delete(key);
        entries.set(key, hit);
        return Promise.resolve(hit.value as T | null);
      }

      const pending = inFlight.get(key);
      if (pending) return pending as Promise<T | null>;

      const promise = load()
        .then((value) => {
          const bytes = sizeOf(value);
          entries.set(key, { value, bytes });
          total += bytes;
          evict();
          return value;
        })
        .finally(() => {
          inFlight.delete(key);
        });

      inFlight.set(key, promise as Promise<CachedMedia | null>);
      return promise;
    },

    has(key: string): boolean {
      return entries.has(key);
    },

    bytes(): number {
      return total;
    },

    clear(): void {
      entries.clear();
      inFlight.clear();
      total = 0;
    },
  };
}

/**
 * Shared budget for thumbnails and full-screen previews alike. Thumbnails are
 * small enough that they rarely evict; a handful of large previews rotate
 * through. Lower this first if the app shows memory pressure on-device.
 */
export const MEDIA_CACHE_BUDGET_BYTES = 300 * 1024 * 1024;

const mediaCache = createMediaCache(MEDIA_CACHE_BUDGET_BYTES);

/** Process-wide media cache. See {@link MediaCache.get}. */
export function cachedMedia<T extends CachedMedia>(
  key: string,
  load: () => Promise<T | null>,
): Promise<T | null> {
  return mediaCache.get(key, load);
}

/**
 * Whether a derived artifact is already held. Lets a viewer render a cached
 * preview without offering to fetch the (multi-MB) source behind it.
 */
export function hasCachedMedia(key: string): boolean {
  return mediaCache.has(key);
}

/** Drop every entry. Intended for tests and teardown. */
export function clearCachedMedia(): void {
  mediaCache.clear();
}
