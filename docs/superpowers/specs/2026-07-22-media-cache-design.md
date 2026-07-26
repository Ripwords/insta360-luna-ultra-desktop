# Session Media Cache

**Date:** 2026-07-22
**Status:** Approved, ready for implementation planning

## Problem

Every media component fetches from the camera independently and throws the
result away on unmount:

- `CameraImage.client.vue` fetches on IntersectionObserver, creates an object
  URL, and revokes it in `onBeforeUnmount`. Scrolling a tile out of the grid and
  back re-downloads the whole JPEG over the camera's Wi-Fi.
- `RawImage.client.vue` does the same, and on the full-screen path additionally
  runs a CPU-bound Bayer decode (`decodeRawToDataUrl`) whose output is discarded
  on close.
- Opening full-screen re-fetches a file the grid already downloaded, because the
  two components share no state.

The camera's embedded HTTP server is slow and capped at
`CAMERA_CONCURRENCY = 4` shared slots, so every avoidable refetch also delays
genuinely new work.

## Goals

- A cached tile costs zero network and zero camera-queue time.
- Reopening a RAW skips both the download and the decode.
- Bounded memory: a long gallery session must not grow without limit.
- No change to object-URL lifetime rules in components (low regression risk).

## Non-goals

- **Disk persistence.** Session memory only; the cache is empty on app start.
  The module is written so a persistent tier could back it later, but that is
  not part of this work.
- **Video thumbnails.** `VideoThumb.client.vue` must use a direct `http` src —
  WKWebView's media stack fails to decode `<video src="blob:...">`. Caching
  there is WebKit's responsibility, not ours.

## Design

### Module: `app/utils/mediaCache.ts`

A module-level singleton. Entries are held in a `Map`, whose insertion order is
maintained as least-recently-used → most-recently-used.

```ts
export const MEDIA_CACHE_BUDGET_BYTES = 300 * 1024 * 1024; // 300 MB

export function cachedMedia<T extends Blob | string>(
  key: string,
  load: () => Promise<T | null>,
): Promise<T | null>;
```

Behaviour:

| Case                     | Result                                                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hit                      | Resolve immediately with the stored value; re-insert the key so it becomes most-recently-used. `load` is never called, so no camera slot is taken. |
| In flight                | Return the _same_ pending promise. Deduplicates the common race where a grid tile and a freshly opened full-screen view request one file.          |
| Miss                     | Await `load()`, store the result, then evict from the LRU end until total bytes ≤ budget.                                                          |
| `load()` resolves `null` | Cache it, sized 0 bytes. `null` means "this source can never produce a preview" (a RAW whose range fetch was skipped), so retrying is pure waste.  |
| `load()` throws          | Do **not** cache. Drop the in-flight entry and rethrow. Camera Wi-Fi failures are transient and must stay retryable.                               |

Entry size is `value.size` for a `Blob` and `value.length` for a string (a
base64 data URL is one byte per character in practice; exactness is not
required, only monotonicity).

Eviction never invalidates rendered images: an object URL created from a blob
keeps that blob alive independently of the cache's reference, so dropping a
cache entry cannot blank an on-screen `<img>`.

### Eviction policy: LRU, not LFU

Gallery access is scroll-driven. A tile just scrolled past is far likelier to
return than one viewed ten times earlier in the session. Pure frequency
counting also suffers cache pollution — an early-viewed photo accumulates hits
that pin it in memory for the rest of the session. Recency matches the access
pattern and is materially simpler.

### What is cached

| Consumer               | Key                             | Value                                                               | Typical size |
| ---------------------- | ------------------------------- | ------------------------------------------------------------------- | ------------ |
| `CameraImage`          | `img:<src>`                     | the final MIME-corrected `Blob`                                     | file size    |
| `RawImage` grid thumb  | `raw:<src>:<maxBytes>:<prefer>` | embedded preview `Blob`, or `null` when the range fetch was skipped | small        |
| `RawImage` full screen | `raw:<src>:full:<prefer>`       | embedded preview `Blob`, or the decoded data URL string             | ~1–3 MB      |

The multi-megabyte source `ArrayBuffer` behind a RAW is deliberately **not**
cached — only the derived preview. Reopening a DNG therefore skips the download
and the decode at a cost of roughly 2 MB of cache rather than 40 MB.

### Call-site changes

`withCameraSlot(...)` moves inside the loader closure, so a cache hit never
queues behind camera traffic.

`CameraImage.client.vue`:

```ts
const blob = await cachedMedia(`img:${props.src}`, () =>
  withCameraSlot(async () => {
    /* existing fetch + MIME correction, unchanged */
  }, priority),
);
```

`RawImage.client.vue` wraps its whole download-plus-derive path (range fetch,
retry loop, `extractDngPreview`, `decodeRawToDataUrl`) in one `cachedMedia`
call, returning the preview `Blob`, the decoded data URL string, or `null`.

Components continue to create their object URL on load and revoke it on
unmount, exactly as today. The cache owns `Blob`s; components own URLs.

The `reason` diagnostic in `RawImage` (`network` / `range-skipped` /
`no-preview` / `decode-failed`) must survive caching: a cached `null` reports
the same reason as the original attempt did, so the loader returns the reason
alongside the value rather than setting the ref as a side effect.

## Testing

`tests/mediaCache.test.ts`, written before the implementation:

1. A hit returns the stored value without invoking the loader a second time.
2. Two concurrent calls for one key invoke the loader exactly once and both
   receive the same value.
3. Exceeding the budget evicts the least-recently-used entry first.
4. Reading an entry protects it — the next eviction takes a colder one instead.
5. A `null` result is cached; a thrown error is not, and a retry re-invokes the
   loader.
6. Total tracked bytes stay within budget across a mix of large and small
   entries.

The budget is injectable (or the module exposes a reset/configure hook for
tests) so tests need not allocate 300 MB.

Existing `tests/cameraQueue.test.ts` must continue to pass unchanged.

## Risks

- **Memory pressure on the desktop app.** 300 MB of blobs is meaningful. The
  budget is a single exported constant so it can be lowered after on-device
  observation.
- **Stale content.** The camera's files are immutable once written, and keys
  include the full URL, so a stale hit would require the camera to reuse a
  filename for different bytes within one session. Accepted.
