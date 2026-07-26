# Transport Seam & Camera Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a swappable `CameraTransport` behind every camera call, then extract the shared UI into a Nuxt layer, so a second Nuxt app (the docs site) can render the real components against a mock camera.

**Architecture:** A module-level registry in `utils/transport.ts` holds the current transport, defaulting to the existing `lunaClient` object — so the desktop app's behaviour is unchanged by construction. Ten call sites move from importing `lunaClient` directly to reading the registry. Then `components/`, `composables/`, `utils/`, `types/`, `assets/`, `pages/` and `app.config.ts` move to `layers/camera/app/`, which the root app extends.

**Tech Stack:** Nuxt 4, Nuxt UI 4, TypeScript 7, Vitest 4, Bun, Tauri 2.

## Global Constraints

- Package manager is **Bun**. Never run `npm` or `yarn`.
- Conventional Commits (`feat:`, `fix:`, `chore:`, `refactor:`, `test:`).
- **Never use `any`.** Use `as unknown as X` only when strictly necessary.
- TDD: write the failing test, watch it fail, then implement.
- `oxlint --deny-warnings` — warnings are failures. The pre-commit hook runs `oxfmt` + `oxlint --fix` on staged files via lint-staged; anything left unfixed aborts the commit. Never `git commit --no-verify`.
- Vue: prop shorthand (`:test` not `:test="test"`), `useTemplateRef()` over manually typed refs, destructuring defaults on `defineProps` over `withDefaults()`.
- This plan must not change desktop behaviour. Any behavioural difference is a bug, not an improvement.

## Reference

Spec: `docs/superpowers/specs/2026-07-26-docs-site-and-live-demo-design.md`

**Do not start Task 7 until the Task 6 gate passes.** Tasks 1–6 are a refactor of a shipping app; Task 7 moves 60+ files and is very hard to review if it lands on top of unverified changes.

---

## File Structure

**Created:**

| File                                        | Responsibility                                             |
| ------------------------------------------- | ---------------------------------------------------------- |
| `app/utils/transport.ts`                    | `CameraTransport` interface + registry. No I/O of its own. |
| `tests/helpers/fakeTransport.ts`            | Reusable fully-stubbed `CameraTransport` for tests.        |
| `tests/transport.test.ts`                   | Registry default/override/reset (node env).                |
| `vitest.nuxt.config.ts`                     | Second vitest config, `environment: "nuxt"`.               |
| `tests/nuxt/useCamera.test.ts`              | Connect, disconnect, reconnect, library refresh.           |
| `tests/nuxt/useGallery.test.ts`             | Delete calls `deleteFiles` with camera paths.              |
| `tests/nuxt/useLiveView.test.ts`            | OSC preferred, annexb fallback, stop.                      |
| `layers/camera/nuxt.config.ts`              | Layer config: `@nuxt/ui`, css, icon bundle.                |
| `layers/camera/app/components/AppShell.vue` | The dashboard shell, formerly `layouts/default.vue`.       |
| `app/layouts/default.vue`                   | Three lines wrapping `<AppShell>`.                         |

**Modified:** `app/utils/lunaClient.ts` (add `fetch`, `probe`, `onDisconnect`), the ten call sites, `vitest.config.ts`, `package.json`, `.github/workflows/ci.yml`, `nuxt.config.ts`.

**Moved in Task 7:** `app/{components,composables,utils,types,assets,pages}` and `app/app.config.ts` → `layers/camera/app/`.

---

### Task 1: `CameraTransport` interface and registry

**Files:**

- Create: `app/utils/transport.ts`
- Create: `tests/helpers/fakeTransport.ts`
- Create: `tests/transport.test.ts`
- Modify: `app/utils/lunaClient.ts` (add three members to the `lunaClient` object)

**Interfaces:**

- Consumes: nothing.
- Produces: `CameraTransport` (interface), `useCameraTransport(): CameraTransport`, `setCameraTransport(t: CameraTransport): void`, `resetCameraTransport(): void`, and `makeFakeTransport(overrides?: Partial<CameraTransport>): CameraTransport` from the test helper. Tasks 3–5 consume all of these.

No call sites change in this task. `lunaClient` keeps its existing named exports, so the app is untouched.

- [ ] **Step 1: Write the failing test**

Create `tests/helpers/fakeTransport.ts`:

```ts
import { vi } from "vitest";
import type { CameraInfo, LiveViewStats, MediaItem } from "~/types/media";
import type { CameraTransport } from "~/utils/transport";

const INFO: CameraInfo = {
  host: "127.0.0.1",
  deviceName: "Luna Ultra",
  serial: "FAKE-0001",
  firmware: "1.0.238",
  ssid: "Luna Ultra.OSC",
};

const STATS: LiveViewStats = { bytes: 0, frames: 0, firstBytesHex: "", seconds: 0 };

/**
 * A `CameraTransport` where every method is a vi.fn() with a benign default.
 * Override only what a test cares about.
 */
export function makeFakeTransport(overrides: Partial<CameraTransport> = {}): CameraTransport {
  const base: CameraTransport = {
    available: true,
    connect: vi.fn(async () => INFO),
    disconnect: vi.fn(async () => {}),
    status: vi.fn(async () => INFO),
    listMedia: vi.fn(async (): Promise<MediaItem[]> => []),
    deleteFiles: vi.fn(async () => {}),
    command: vi.fn(async () => new Uint8Array(0)),
    liveViewStart: vi.fn(async () => ({ url: "http://127.0.0.1:9000/live", port: 9000 })),
    liveViewStop: vi.fn(async () => {}),
    liveViewStats: vi.fn(async () => STATS),
    probeOscPreview: vi.fn(async (): Promise<string | null> => null),
    fetch: vi.fn(async () => new Response(null, { status: 200 })),
    probe: vi.fn(async () => true),
    onDisconnect: vi.fn(async () => () => {}),
  };
  return { ...base, ...overrides };
}
```

Both `INFO` and `STATS` are complete against `app/types/media.ts` as of this plan — `CameraInfo` has five fields (four optional) and `LiveViewStats` has exactly `bytes`, `frames`, `firstBytesHex`, `seconds`. If either type has gained a field since, add it here rather than casting.

Create `tests/transport.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { lunaClient } from "~/utils/lunaClient";
import { resetCameraTransport, setCameraTransport, useCameraTransport } from "~/utils/transport";
import { makeFakeTransport } from "./helpers/fakeTransport";

describe("cameraTransport registry", () => {
  afterEach(() => {
    resetCameraTransport();
  });

  it("defaults to the real luna client", () => {
    expect(useCameraTransport()).toBe(lunaClient);
  });

  it("returns the transport that was set", () => {
    const fake = makeFakeTransport();
    setCameraTransport(fake);
    expect(useCameraTransport()).toBe(fake);
  });

  it("restores the real client on reset", () => {
    setCameraTransport(makeFakeTransport());
    resetCameraTransport();
    expect(useCameraTransport()).toBe(lunaClient);
  });

  it("routes calls to the active transport", async () => {
    const fake = makeFakeTransport();
    setCameraTransport(fake);
    await useCameraTransport().connect("10.0.0.1");
    expect(fake.connect).toHaveBeenCalledWith("10.0.0.1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun x vitest run tests/transport.test.ts`
Expected: FAIL — `Failed to resolve import "~/utils/transport"`.

- [ ] **Step 3: Add the three missing members to `lunaClient`**

In `app/utils/lunaClient.ts`, inside the `export const lunaClient = { ... }` object, after `listMedia`, add:

```ts
  /** Replaces the standalone `cameraFetch` export; health reporting included. */
  fetch: cameraFetch,

  /** Replaces the standalone `probeCamera` export; bypasses health reporting. */
  probe: probeCamera,

  /**
   * Subscribe to the Rust side's disconnect event. Returns an unlisten fn.
   * In a plain browser there is no event source, so this is a no-op — which is
   * what lets a non-Tauri transport implementation exist at all.
   */
  async onDisconnect(handler: () => void): Promise<() => void> {
    if (!isTauri()) return () => {};
    const { listen } = await import("@tauri-apps/api/event");
    return await listen("luna://disconnected", () => handler());
  },
```

`cameraFetch` and `probeCamera` are function declarations above `lunaClient`, so they are hoisted and safe to reference here.

- [ ] **Step 4: Create the registry**

Create `app/utils/transport.ts`:

```ts
import type { CameraInfo, LiveViewStats, MediaItem } from "~/types/media";
import { lunaClient } from "~/utils/lunaClient";

/**
 * Everything the UI needs from a camera. The desktop app supplies the real
 * TCP/HTTP client; the docs-site demo supplies an in-browser mock. Nothing in
 * `components/` or `composables/` may import a concrete client directly.
 */
export interface CameraTransport {
  readonly available: boolean;
  connect(host: string): Promise<CameraInfo>;
  disconnect(): Promise<void>;
  status(): Promise<CameraInfo | null>;
  listMedia(host: string): Promise<MediaItem[]>;
  deleteFiles(cameraPaths: string[]): Promise<void>;
  command(code: number, body: Uint8Array): Promise<Uint8Array>;
  liveViewStart(): Promise<{ url: string; port: number }>;
  liveViewStop(): Promise<void>;
  liveViewStats(): Promise<LiveViewStats>;
  probeOscPreview(host: string): Promise<string | null>;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  probe(host: string): Promise<boolean>;
  onDisconnect(handler: () => void): Promise<() => void>;
}

/**
 * The real client is the default, so the desktop app behaves identically
 * whether or not anything ever calls `setCameraTransport`.
 */
let current: CameraTransport = lunaClient;

export function setCameraTransport(transport: CameraTransport): void {
  current = transport;
}

/** Restore the real client. Used by tests; never called by app code. */
export function resetCameraTransport(): void {
  current = lunaClient;
}

export function useCameraTransport(): CameraTransport {
  return current;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun x vitest run tests/transport.test.ts`
Expected: PASS, 4 tests.

If `lunaClient` fails to satisfy `CameraTransport`, TypeScript will say which member is missing — fix `lunaClient`, never widen the interface with `any`.

- [ ] **Step 6: Verify nothing else broke**

Run: `bun x vitest run && bun run typecheck && bun run lint`
Expected: all pass. No existing test touches `lunaClient`, so nothing should move.

- [ ] **Step 7: Commit**

```bash
git add app/utils/transport.ts app/utils/lunaClient.ts tests/transport.test.ts tests/helpers/fakeTransport.ts
git commit -m "feat(transport): add swappable CameraTransport registry"
```

---

### Task 2: Nuxt test environment

**Files:**

- Create: `vitest.nuxt.config.ts`
- Create: `tests/nuxt/harness.ts`
- Create: `tests/nuxt/smoke.test.ts`
- Modify: `vitest.config.ts`, `package.json`, `.github/workflows/ci.yml`

**Interfaces:**

- Consumes: nothing.
- Produces: `mountComposable<T>(fn: () => T): Promise<T>` from `tests/nuxt/harness.ts`, used by Tasks 3 and 4. A `bun run test` script that runs both vitest projects.

**This is the highest-uncertainty task in the plan.** Its only deliverable is _a trivial composable test passing_ — prove the environment works before Tasks 3–5 depend on it. Do not fold any real test into this task.

- [ ] **Step 1: Add the dev dependencies**

```bash
bun add -d @nuxt/test-utils @vue/test-utils happy-dom
```

- [ ] **Step 2: Scope the existing config to node-only tests**

Modify `vitest.config.ts` — add the `exclude`, change nothing else:

```ts
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./app", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    // Composable tests need a Nuxt runtime; they run under vitest.nuxt.config.ts
    exclude: ["tests/nuxt/**"],
    environment: "node",
  },
});
```

- [ ] **Step 3: Add the Nuxt vitest config**

Create `vitest.nuxt.config.ts`:

```ts
import { defineVitestConfig } from "@nuxt/test-utils/config";

export default defineVitestConfig({
  test: {
    include: ["tests/nuxt/**/*.test.ts"],
    environment: "nuxt",
  },
});
```

The `nuxt` environment builds the app's Nuxt context, so `~` resolution, auto-imports and `useState` all work without extra aliasing.

- [ ] **Step 4: Write the harness and a smoke test**

Create `tests/nuxt/harness.ts`:

```ts
import { mountSuspended } from "@nuxt/test-utils/runtime";
import { defineComponent } from "vue";

/**
 * Run a composable inside a real Nuxt app instance and hand back what it
 * returned. Composables here call `useState`, which needs a Nuxt app on the
 * call stack — hence a mounted component rather than a bare call.
 */
export async function mountComposable<T>(fn: () => T): Promise<T> {
  let result!: T;
  await mountSuspended(
    defineComponent({
      setup() {
        result = fn();
        return () => null;
      },
    }),
  );
  return result;
}
```

Create `tests/nuxt/smoke.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mountComposable } from "./harness";

describe("nuxt test environment", () => {
  it("runs a composable that uses useState", async () => {
    const state = await mountComposable(() => useState<number>("smoke", () => 41));
    expect(state.value).toBe(41);
    state.value = 42;
    expect(state.value).toBe(42);
  });
});
```

- [ ] **Step 5: Run the smoke test**

Run: `bun x vitest run -c vitest.nuxt.config.ts`
Expected: PASS, 1 test. First run is slow — it builds a Nuxt context.

If the environment fails to boot, fix it here and now. Do not proceed to Task 3 with a broken environment, and do not work around it by testing composables in the node project — they cannot run there.

- [ ] **Step 6: Wire both projects into one command**

In `package.json`, add to `scripts`:

```json
"test": "vitest run && vitest run -c vitest.nuxt.config.ts",
```

In `.github/workflows/ci.yml`, in the `frontend` job, replace the unit-test step's command:

```yaml
- name: Unit tests
  if: ${{ !cancelled() }}
  run: bun run test
```

- [ ] **Step 7: Run the full suite**

Run: `bun run test && bun run typecheck && bun run lint`
Expected: all pass — 17 existing node test files plus transport, plus the smoke test.

- [ ] **Step 8: Commit**

```bash
git add vitest.config.ts vitest.nuxt.config.ts tests/nuxt package.json bun.lock .github/workflows/ci.yml
git commit -m "test: add Nuxt test environment for composables"
```

---

### Task 3: Migrate `useCamera` to the transport

**Files:**

- Modify: `app/composables/useCamera.ts`
- Create: `tests/helpers/media.ts`
- Create: `tests/nuxt/useCamera.test.ts`

**Interfaces:**

- Consumes: `useCameraTransport`, `setCameraTransport`, `resetCameraTransport` (Task 1); `makeFakeTransport` (Task 1); `mountComposable` (Task 2).
- Produces: `useCamera()` with an unchanged public return shape — `{ status, info, library, host, error, loadingLibrary, isConnected, isBusy, available, connect, disconnect, refreshLibrary, removeFromLibrary }`. Tasks 4 and 5 rely on this being unchanged. Also `makeMediaItem(overrides?: Partial<MediaItem>): MediaItem`, consumed by Task 4.

Six references change: lines 43, 58, 66, 98–100, 120, 131, 140, 148, 166.

- [ ] **Step 1: Write the failing test**

Create `tests/helpers/media.ts`. `MediaItem` has eleven required fields, so tests
build real ones — never a partial object with a cast:

```ts
import type { MediaItem } from "~/types/media";

/** A complete, valid MediaItem. Override only the fields a test asserts on. */
export function makeMediaItem(overrides: Partial<MediaItem> = {}): MediaItem {
  const name = overrides.name ?? "IMG_0001.jpg";
  const cameraPath = overrides.cameraPath ?? `/DCIM/Camera01/${name}`;
  return {
    id: cameraPath,
    name,
    type: "photo",
    storage: "internal",
    ext: "jpg",
    renderable: true,
    panoramic: false,
    takenAt: Date.UTC(2026, 6, 26, 12, 0, 0),
    size: 4_200_000,
    cameraPath,
    srcUrl: `http://127.0.0.1${cameraPath}`,
    ...overrides,
  };
}
```

Create `tests/nuxt/useCamera.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetCameraTransport, setCameraTransport } from "~/utils/transport";
import { makeFakeTransport } from "../helpers/fakeTransport";
import { makeMediaItem } from "../helpers/media";
import { mountComposable } from "./harness";

describe("useCamera", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    resetCameraTransport();
  });

  it("connects through the active transport and loads the library", async () => {
    const transport = makeFakeTransport({
      listMedia: vi.fn(async () => [makeMediaItem()]),
    });
    setCameraTransport(transport);

    const camera = await mountComposable(() => useCamera());
    await camera.connect();

    expect(transport.connect).toHaveBeenCalledWith(camera.host.value);
    expect(camera.isConnected.value).toBe(true);
    expect(camera.library.value).toHaveLength(1);
  });

  it("reports unavailable transports instead of connecting", async () => {
    setCameraTransport(makeFakeTransport({ available: false }));

    const camera = await mountComposable(() => useCamera());
    await camera.connect();

    expect(camera.isConnected.value).toBe(false);
    expect(camera.error.value).toContain("desktop app");
  });

  it("surfaces a connect failure as an error, not a thrown exception", async () => {
    setCameraTransport(
      makeFakeTransport({
        connect: vi.fn(async () => {
          throw new Error("no route to host");
        }),
      }),
    );

    const camera = await mountComposable(() => useCamera());
    await expect(camera.connect()).resolves.toBeUndefined();
    expect(camera.error.value).toBe("no route to host");
    expect(camera.isConnected.value).toBe(false);
  });

  it("subscribes to disconnect through the transport, not Tauri directly", async () => {
    const transport = makeFakeTransport();
    setCameraTransport(transport);

    const camera = await mountComposable(() => useCamera());
    await camera.connect();

    expect(transport.onDisconnect).toHaveBeenCalledTimes(1);
  });

  it("tears the session down on disconnect", async () => {
    const transport = makeFakeTransport();
    setCameraTransport(transport);

    const camera = await mountComposable(() => useCamera());
    await camera.connect();
    await camera.disconnect();

    expect(transport.disconnect).toHaveBeenCalled();
    expect(camera.isConnected.value).toBe(false);
    expect(camera.library.value).toEqual([]);
  });
});
```

Note `localStorage.clear()` in `beforeEach`: `useCamera` persists the host to
`luna-camera-host`, so without it a host set by one test leaks into the next.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun x vitest run -c vitest.nuxt.config.ts tests/nuxt/useCamera.test.ts`
Expected: FAIL — `transport.connect` not called (the composable still uses the imported `lunaClient`), and `onDisconnect` not called.

- [ ] **Step 3: Rewrite the imports and call sites**

In `app/composables/useCamera.ts`, replace line 2:

```ts
import { useCameraTransport } from "~/utils/transport";
```

Then replace each usage. Line 43:

```ts
const available = computed(() => useCameraTransport().available);
```

In `tryReconnect` (lines 58 and 66):

```ts
info.value = await useCameraTransport().connect(host.value);
```

```ts
        () => useCameraTransport().probe(host.value),
```

Replace `watchDisconnect` entirely (lines 97–113):

```ts
async function watchDisconnect() {
  const transport = useCameraTransport();
  if (!transport.available || disconnectUnlisten) return;
  disconnectUnlisten = await transport.onDisconnect(() => {
    status.value = "disconnected";
    info.value = null;
    library.value = [];
    error.value = "Lost connection to the camera. Reconnecting…";
    retryAttempt.value = 0;
    // This is a known socket close, not a silently-unresponsive camera: disarm the
    // health detector so its failure count can't race scheduleReconnect() below and
    // trigger forceDisconnect(), which would cancel this reconnect. It re-arms itself
    // once tryReconnect() succeeds again.
    disarmCameraHealth();
    scheduleReconnect();
  });
}
```

Line 120 in `refreshLibrary`:

```ts
library.value = await useCameraTransport().listMedia(host.value);
```

Lines 131, 140, 148 in `connect`:

```ts
    if (!useCameraTransport().available) {
```

```ts
info.value = await useCameraTransport().connect(host.value);
```

```ts
        () => useCameraTransport().probe(host.value),
```

Line 166 in `teardown`:

```ts
await useCameraTransport().disconnect();
```

Read the registry at each call site rather than caching it in a module-level
const — a cached reference would pin whichever transport happened to be
registered when the module first evaluated.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun x vitest run -c vitest.nuxt.config.ts tests/nuxt/useCamera.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Verify the whole suite**

Run: `bun run test && bun run typecheck && bun run lint`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add app/composables/useCamera.ts tests/helpers/media.ts tests/nuxt/useCamera.test.ts
git commit -m "refactor(camera): read the camera through the transport registry"
```

---

### Task 4: Migrate `useGallery` and `useLiveView`

**Files:**

- Modify: `app/composables/useGallery.ts:4,73`
- Modify: `app/composables/useLiveView.ts:2,34,44,53,72,77`
- Create: `tests/nuxt/useGallery.test.ts`
- Create: `tests/nuxt/useLiveView.test.ts`

**Interfaces:**

- Consumes: `useCameraTransport` (Task 1), `makeFakeTransport` (Task 1), `mountComposable` (Task 2), `useCamera()` (Task 3, unchanged shape).
- Produces: `useGallery()` and `useLiveView()` with unchanged public shapes.

- [ ] **Step 1: Write the failing tests**

Create `tests/nuxt/useGallery.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetCameraTransport, setCameraTransport } from "~/utils/transport";
import { makeFakeTransport } from "../helpers/fakeTransport";
import { makeMediaItem } from "../helpers/media";
import { mountComposable } from "./harness";

describe("useGallery", () => {
  afterEach(() => {
    resetCameraTransport();
  });

  it("deletes through the transport using camera paths", async () => {
    const transport = makeFakeTransport();
    setCameraTransport(transport);

    const { camera, gallery } = await mountComposable(() => ({
      camera: useCamera(),
      gallery: useGallery(),
    }));

    camera.library.value = [
      makeMediaItem({ id: "a", name: "IMG_0001.jpg" }),
      makeMediaItem({ id: "b", name: "IMG_0002.jpg" }),
    ];
    gallery.selected.value = new Set(["a"]);

    await gallery.deleteSelected();

    expect(transport.deleteFiles).toHaveBeenCalledWith(["/DCIM/Camera01/IMG_0001.jpg"]);
    expect(camera.library.value).toHaveLength(1);
  });

  it("leaves the library intact when the camera rejects the delete", async () => {
    setCameraTransport(
      makeFakeTransport({
        deleteFiles: vi.fn(async () => {
          throw new Error("rejected");
        }),
      }),
    );

    const { camera, gallery } = await mountComposable(() => ({
      camera: useCamera(),
      gallery: useGallery(),
    }));

    camera.library.value = [makeMediaItem({ id: "a", name: "IMG_0001.jpg" })];
    gallery.selected.value = new Set(["a"]);

    await gallery.deleteSelected();

    expect(camera.library.value).toHaveLength(1);
  });
});
```

Create `tests/nuxt/useLiveView.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetCameraTransport, setCameraTransport } from "~/utils/transport";
import { makeFakeTransport } from "../helpers/fakeTransport";
import { mountComposable } from "./harness";

describe("useLiveView", () => {
  afterEach(() => {
    resetCameraTransport();
  });

  it("prefers an OSC MJPEG preview when the camera offers one", async () => {
    const transport = makeFakeTransport({
      probeOscPreview: vi.fn(async () => "http://cam/osc/commands/execute"),
    });
    setCameraTransport(transport);

    const { camera, live } = await mountComposable(() => ({
      camera: useCamera(),
      live: useLiveView(),
    }));
    await camera.connect();
    await live.start();

    expect(live.transport.value).toBe("mjpeg");
    expect(live.streamUrl.value).toBe("http://cam/osc/commands/execute");
    expect(transport.liveViewStart).not.toHaveBeenCalled();
  });

  it("falls back to the control-session annexb stream", async () => {
    const transport = makeFakeTransport();
    setCameraTransport(transport);

    const { camera, live } = await mountComposable(() => ({
      camera: useCamera(),
      live: useLiveView(),
    }));
    await camera.connect();
    await live.start();

    expect(live.transport.value).toBe("annexb");
    expect(live.streamUrl.value).toBe("http://127.0.0.1:9000/live");
  });

  it("refuses to start when the camera is not connected", async () => {
    setCameraTransport(makeFakeTransport());

    const live = await mountComposable(() => useLiveView());
    await live.start();

    expect(live.active.value).toBe(false);
    expect(live.error.value).toBe("Connect to the camera first.");
  });

  it("stops through the transport and clears the stream", async () => {
    const transport = makeFakeTransport();
    setCameraTransport(transport);

    const { camera, live } = await mountComposable(() => ({
      camera: useCamera(),
      live: useLiveView(),
    }));
    await camera.connect();
    await live.start();
    await live.stop();

    expect(transport.liveViewStop).toHaveBeenCalled();
    expect(live.active.value).toBe(false);
    expect(live.streamUrl.value).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun x vitest run -c vitest.nuxt.config.ts tests/nuxt/useGallery.test.ts tests/nuxt/useLiveView.test.ts`
Expected: FAIL — the fake's `deleteFiles`/`probeOscPreview` are never called, because both composables still import `lunaClient`.

- [ ] **Step 3: Migrate `useGallery`**

Replace line 4 with:

```ts
import { useCameraTransport } from "~/utils/transport";
```

Replace line 73:

```ts
await useCameraTransport().deleteFiles(removed.map((item) => item.cameraPath));
```

- [ ] **Step 4: Migrate `useLiveView`**

Replace line 2 with:

```ts
import { useCameraTransport } from "~/utils/transport";
```

Then lines 34, 44, 53, 72, 77 respectively:

```ts
const osc = await useCameraTransport().probeOscPreview(host.value);
```

```ts
const info = await useCameraTransport().liveViewStart();
```

```ts
const stats = await useCameraTransport()
  .liveViewStats()
  .catch(() => null);
```

```ts
await useCameraTransport()
  .liveViewStop()
  .catch(() => {});
```

```ts
return useCameraTransport()
  .liveViewStats()
  .catch(() => null);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun x vitest run -c vitest.nuxt.config.ts`
Expected: PASS — smoke, useCamera, useGallery (2), useLiveView (4).

- [ ] **Step 6: Verify the whole suite**

Run: `bun run test && bun run typecheck && bun run lint`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add app/composables/useGallery.ts app/composables/useLiveView.ts tests/nuxt/useGallery.test.ts tests/nuxt/useLiveView.test.ts
git commit -m "refactor(camera): route gallery and live view through the transport"
```

---

### Task 5: Migrate the remaining call sites and seal the seam

**Files:**

- Modify: `app/components/CameraImage.vue:2,57`
- Modify: `app/components/PanoViewer.vue:3,25`
- Modify: `app/components/RawImage.vue:2,127`
- Modify: `app/components/WatermarkCanvas.vue:4,59`
- Modify: `app/composables/useDownloads.ts:4,44`
- Modify: `app/utils/lunaCapture.ts:2,18,25,32,41`
- Modify: `app/utils/lunaSettings.ts:10,45,79,93,114,131`
- Modify: `app/utils/lunaClient.ts` (drop the now-unused standalone exports)

**Interfaces:**

- Consumes: `useCameraTransport` (Task 1).
- Produces: nothing new. After this task, `lunaClient` is imported by exactly one module in the codebase — `app/utils/transport.ts`. That invariant is what makes the demo possible, and Step 6 enforces it.

- [ ] **Step 1: Replace `cameraFetch` in the four components**

In each of `CameraImage.vue`, `PanoViewer.vue`, `RawImage.vue` and `WatermarkCanvas.vue`, replace the import:

```ts
import { useCameraTransport } from "~/utils/transport";
```

and the call, preserving each site's existing arguments:

```ts
// CameraImage.vue:57
const response = await useCameraTransport().fetch(src);

// PanoViewer.vue:25
const response = await useCameraTransport().fetch(props.src);

// RawImage.vue:127 — keeps its second argument
const response = await useCameraTransport().fetch(src, init);

// WatermarkCanvas.vue:59
const response = await useCameraTransport().fetch(props.src);
```

- [ ] **Step 2: Replace `cameraFetch` in `useDownloads`**

Replace line 4's import with `import { useCameraTransport } from "~/utils/transport";` and line 44 with:

```ts
const response = await useCameraTransport().fetch(entry.item.srcUrl);
```

- [ ] **Step 3: Replace `lunaClient.command` in `lunaCapture` and `lunaSettings`**

In both files, swap the import for `import { useCameraTransport } from "~/utils/transport";`, then replace every `lunaClient.command(` with `useCameraTransport().command(`. There are four sites in `lunaCapture.ts` (18, 25, 32, 41) and five in `lunaSettings.ts` (45, 79, 93, 114, 131). Change nothing else — the command codes, bodies and decoding all stay exactly as they are.

- [ ] **Step 4: Remove the standalone exports**

In `app/utils/lunaClient.ts`, change `export async function cameraFetch` to `async function cameraFetch` and `export async function probeCamera` to `async function probeCamera`. Both are still referenced by the `lunaClient` object as `fetch` and `probe`; they are simply no longer importable from outside.

- [ ] **Step 5: Verify**

Run: `bun run test && bun run typecheck && bun run lint`
Expected: all pass. `typecheck` is the real check here — any missed call site is now a compile error, since `cameraFetch` and `probeCamera` no longer exist as imports.

- [ ] **Step 6: Assert the invariant**

Run:

```bash
grep -rn "lunaClient" app --include='*.ts' --include='*.vue' | grep -v '^app/utils/lunaClient.ts' | grep -v '^app/utils/transport.ts'
```

Expected: **no output.** If anything prints, that file bypasses the seam and will break the demo — migrate it before committing.

- [ ] **Step 7: Commit**

```bash
git add app/components app/composables app/utils
git commit -m "refactor(camera): route every camera call through the transport"
```

---

### Task 6: Verification gate

**Files:** none — this task changes no code.

**Interfaces:**

- Consumes: everything from Tasks 1–5.
- Produces: confidence that the refactor is behaviour-preserving. **Task 7 must not begin until every check below passes.**

The spec's whole risk argument rests on this gate. The transport refactor touched the connect/reconnect/delete/download paths, and this project's failure mode is silent — the camera accepts and echoes bad writes without erroring. Automated tests cannot catch that.

- [ ] **Step 1: Full automated suite**

```bash
bun run test
bun run typecheck
bun run lint
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: all pass.

- [ ] **Step 2: Start the mock camera**

```bash
node luna_mock_server/server.mjs --root /path/to/media --host 127.0.0.1 --http-port 18080 --tcp-port 6666
```

Substitute a real folder of media for `/path/to/media`.

- [ ] **Step 3: Drive the desktop app against it**

```bash
bun run dev
```

Connect to `127.0.0.1:18080` from the Connect screen, then confirm each of these by hand:

- [ ] Connect succeeds and device info renders in the sidebar chip.
- [ ] The gallery populates. (A "Nothing here" empty state on a connected session means the media index came back non-ok — that is a real regression in this refactor, not a UI issue.)
- [ ] A photo opens in full-screen preview.
- [ ] Multi-select works: click, shift-click range, per-day select.
- [ ] A download completes and lands in `Downloads/Luna Ultra/`, watermark applied.
- [ ] A delete removes the file from the camera and from the grid.
- [ ] Disconnect tears the session down and clears the library.
- [ ] Reconnect works after a disconnect.
- [ ] Killing the mock server mid-session surfaces the health-detector disconnect rather than hanging.

- [ ] **Step 4: Confirm against the real camera if it is to hand**

Not strictly required, but the settings read-back path is the one place the mock cannot prove correctness — options are stored per function-mode and proto3 omits defaults, so a wrong write can read back looking right. If the camera is available, change one pro-bar setting and confirm it on the camera's own screen.

- [ ] **Step 5: Record the result**

If anything above failed, stop and fix it before Task 7. If everything passed, note it in the commit:

```bash
git commit --allow-empty -m "chore: verify transport seam against luna_mock_server"
```

---

### Task 7: Extract the `camera` layer

**Files:**

- Create: `layers/camera/nuxt.config.ts`
- Create: `layers/camera/app/components/AppShell.vue`
- Create: `app/layouts/default.vue` (replacing the old one)
- Move: `app/{components,composables,utils,types,assets,pages}` → `layers/camera/app/`
- Move: `app/app.config.ts` → `layers/camera/app/app.config.ts`
- Modify: `nuxt.config.ts`, `vitest.config.ts`, `.gitignore` (if it references `app/`)
- Keep in place: `app/app.vue`

**Interfaces:**

- Consumes: the sealed seam from Task 5.
- Produces: a layer at `layers/camera` that any Nuxt app can `extends`. The docs site (second plan) depends only on this path and on `CameraTransport`.

Pure file moves plus config. **No logic edits.** If you find yourself changing behaviour, stop — it belongs in an earlier task.

- [ ] **Step 1: Move the directories with git**

```bash
mkdir -p layers/camera/app
git mv app/components layers/camera/app/components
git mv app/composables layers/camera/app/composables
git mv app/utils layers/camera/app/utils
git mv app/types layers/camera/app/types
git mv app/assets layers/camera/app/assets
git mv app/pages layers/camera/app/pages
git mv app/app.config.ts layers/camera/app/app.config.ts
```

`git mv` keeps rename detection intact, which makes this reviewable. `app/app.vue` stays where it is — it is the root app's entry, not shared.

- [ ] **Step 2: Turn the layout into a component**

```bash
git mv app/layouts/default.vue layers/camera/app/components/AppShell.vue
```

The file needs **no edits** — it already ends with `<slot />` inside `UDashboardGroup`, which is exactly what a shell component wants.

- [ ] **Step 3: Give the root app a layout again**

Create `app/layouts/default.vue`:

```vue
<template>
  <AppShell>
    <slot />
  </AppShell>
</template>
```

`AppShell` resolves via the layer's auto-imported components. The layout is deliberately not named `app-shell`: the root app's pages have no `definePageMeta({ layout })`, so they must keep finding a `default` layout.

- [ ] **Step 4: Write the layer config**

Create `layers/camera/nuxt.config.ts`:

```ts
export default defineNuxtConfig({
  modules: ["@nuxt/ui"],
  // Bundle every statically-referenced icon so the app works fully offline
  // (the Tauri build must never fetch icons from the Iconify CDN at runtime)
  icon: {
    clientBundle: {
      scan: true,
      sizeLimitKb: 512,
    },
  },
  css: ["~/assets/css/main.css"],
  compatibilityDate: "2026-06-30",
});
```

Inside a layer, `~` resolves to that layer's own `app/` directory, so the css path points at the file just moved to `layers/camera/app/assets/css/main.css`.

- [ ] **Step 5: Slim the root config**

Rewrite `nuxt.config.ts`, moving the shared keys out and keeping only what is Tauri-specific:

```ts
// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  extends: ["./layers/camera"],
  devtools: {
    enabled: true,
  },
  compatibilityDate: "2026-06-30",
  ssr: false,
  vite: {
    // Better support for Tauri CLI output
    clearScreen: false,
    // Enable environment variables
    // Additional environment variables can be found at
    // https://v2.tauri.app/reference/environment-variables/
    envPrefix: ["VITE_", "TAURI_"],
    server: {
      // Tauri requires a consistent port
      strictPort: true,
    },
  },
  // Avoids error [unhandledRejection] EMFILE: too many open files, watch
  ignore: ["**/src-tauri/**"],
});
```

`modules`, `icon` and `css` now come from the layer.

- [ ] **Step 6: Repoint the vitest alias**

In `vitest.config.ts`, the `~` alias must follow the moved files:

```ts
    alias: {
      "~": fileURLToPath(new URL("./layers/camera/app", import.meta.url)),
    },
```

`vitest.nuxt.config.ts` needs no change — the Nuxt environment resolves `~` through the real Nuxt context, which now includes the layer.

- [ ] **Step 7: Run the full suite**

Run: `bun run test && bun run typecheck && bun run lint`
Expected: all pass. Failures here are almost always a stale import path or the alias in Step 6.

- [ ] **Step 8: Confirm the app still builds and runs**

```bash
bun run dev
```

Expected: the app boots, the sidebar renders with its nav, status chip and update banner, and all five routes (`/`, `/camera`, `/gallery`, `/downloads`, `/settings`) resolve exactly as before.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: extract shared camera UI into layers/camera"
```

---

### Task 8: Post-move verification and documentation

**Files:**

- Modify: `README.md` (the "Project layout" details block, plus the test commands)

`CLAUDE.md` needs no edit — its Vue conventions use generic examples and never
name `app/` paths. Step 5's grep confirms that rather than assuming it.

**Interfaces:**

- Consumes: the layer from Task 7.
- Produces: a repo whose documented layout matches its actual layout, ready for the docs-site plan.

- [ ] **Step 1: Re-run the Task 6 manual checklist**

Repeat Task 6 Steps 2 and 3 in full against `luna_mock_server`. The file move should have changed nothing, which is exactly why it is worth proving — a broken import path can typecheck and still fail at runtime through a dynamic import.

- [ ] **Step 2: Update the README project layout**

In `README.md`, inside the "Project layout" `<details>` block, replace the tree with:

```
layers/camera/app/       Shared UI layer (extended by the desktop app)
  components/               Vue components, incl. AppShell (the dashboard shell)
  composables/useCamera     Connection lifecycle, auto-reconnect
  composables/useGallery    Selection, filtering, delete
  composables/useDownloads  Download queue + watermark compositing
  composables/useUpdater    Auto-update checker
  utils/transport.ts        CameraTransport interface + registry
  utils/lunaClient.ts       Real transport: Rust commands + HTTP listing
  utils/lunaIndex.ts        Camera HTTP index parser
  utils/watermark*.ts       Official watermark placement engine
  pages/                    Connect, camera, gallery, downloads, settings
app/                     Desktop app entry (app.vue, default layout)
src-tauri/src/luna.rs    Luna Ultra TCP control protocol (Rust)
luna_mock_server/        Camera emulator for development and tests
scripts/probe-*.mjs      On-device protocol probes (calibration, live view, file list)
tests/                   Vitest unit tests (node) and tests/nuxt (Nuxt runtime)
docs/FEATURES.md         Feature map: shipped, gated, and on hold
docs/superpowers/specs/  Protocol findings of record
screenshots/             Product screenshots
```

- [ ] **Step 3: Add a note on the seam to the README development section**

After the test commands block in `## Development`, add:

```markdown
Every camera call goes through `CameraTransport` (`layers/camera/app/utils/transport.ts`).
`lunaClient` — the real TCP/HTTP implementation — is imported by that one module
and nowhere else, which is what lets tests and the docs-site demo swap in a fake
camera. Keep it that way.
```

- [ ] **Step 4: Update the test commands in the README**

Replace `bun x vitest run` with `bun run test` in the `## Development` block, and annotate it:

```
bun run test                                       # frontend unit tests (node + Nuxt)
```

- [ ] **Step 5: Verify the docs are accurate**

Run:

```bash
bun run test && bun run typecheck && bun run lint
grep -rn "app/components\|app/composables\|app/utils" README.md CLAUDE.md
```

Expected: tests pass; the grep returns nothing that describes the old layout as current.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: describe the camera layer and transport seam"
```

---

## Done

At the end of this plan:

- Every camera call reads `useCameraTransport()`; `lunaClient` is imported by exactly one module.
- The composables have test coverage they have never had, driven by a fake camera.
- `layers/camera` is a self-contained Nuxt layer any app can extend.
- The desktop app behaves exactly as it did before.

The second plan — docs site, mock transport, fixtures, inline demo components — depends on this one only through the `layers/camera` path and the `CameraTransport` interface.
