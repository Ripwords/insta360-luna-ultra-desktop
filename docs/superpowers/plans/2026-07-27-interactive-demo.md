# Interactive Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the docs site's `/demo/*` routes — which currently render the real app against an unavailable camera — into a working in-browser demo driven by a mock `CameraTransport`, and make the app's real components embeddable inline in documentation prose.

**Architecture:** A `MockCameraTransport` implements the same `CameraTransport` interface the desktop app uses, registered from a **client-only** Nuxt plugin. It fakes the wire, not the logic: it emits camera-style file paths that the app's real `entriesFromPaths`/`buildMediaItems` parse, and answers the protobuf command channel with real encoded messages, so the shipping code runs unmodified. Media fixtures are generated deterministically with ffmpeg.

**Tech Stack:** Nuxt 4.5, Nuxt UI 4.10, `@nuxt/content` ^3, Bun, ffmpeg (fixture generation), WebCodecs (live view).

## Global Constraints

- Package manager is **Bun**. Never run `npm` or `yarn`.
- Conventional Commits.
- **Never use `any`.** `as unknown as X` only when strictly necessary. `as never` is banned.
- `oxlint --deny-warnings` — warnings are failures. The pre-commit hook runs `oxfmt` + `oxlint --fix` on staged files. Never `git commit --no-verify`.
- Vue conventions, **not lint-enforced, apply by hand**: prop shorthand (`:foo`, not `:foo="foo"`); `useTemplateRef()` rather than a manually typed ref bound to `ref="..."`; destructuring defaults on `defineProps`, never `withDefaults()`.
- **Exactly one change to `app/` is permitted in this entire plan**: Task 1's `AppShell.vue` extraction. Every other task must leave `git diff --stat -- app/` empty. This is an explicit project decision — the desktop app is not modified for the docs site's benefit.
- Desktop app baseline, checked every task: `bun run test` → node 19 files/289 tests + nuxt 4 files/12 tests, `bun run typecheck`, `bun run lint`.
- **Cross-layer imports use the `#layer` alias, never `~/`.** `~/utils/foo` does not resolve from `docs/site` for values *or* types.
- **Nothing transitively imported by a `*.worker.ts` may use a `~/` specifier** — Vite's isolated worker sub-build resolves the layer's `~` against the consuming app's srcDir.
- The site is served at `https://ripwords.github.io/insta360-luna-ultra-desktop/`; `app.baseURL` is `/insta360-luna-ultra-desktop/` and `site.url` is origin-only.
- **Never verify deploy-facing behaviour with `nuxt preview`** — it runs a Nitro server GitHub Pages does not have, and has already masked two defects on this project. Serve `docs/site/.output/public` with a plain static server (`python3 -m http.server`, which reproduces GitHub Pages' trailing-slash 301) rooted so the site sits under the base path.
- **Every fixture URL must be built through the runtime base URL**, never hardcoded — a `/demo/fixtures/...` literal 404s in production.

## Reference

Spec: `docs/superpowers/specs/2026-07-26-docs-site-and-live-demo-design.md`
Prerequisites (merged): the transport seam plan, and the docs site plan.

**The honesty rule.** Live view and capture are simulated; gallery, preview, multi-select, watermark compositing and download are real code running for real. Every demo screen carries a persistent "simulated camera" badge, and no page may imply the browser is talking to hardware.

**Fixture licensing.** Fixtures are **generated with ffmpeg**, not downloaded. This is deliberate: it is reproducible, requires no network at build time, and carries no licence risk. (iStock was considered and rejected — its content licence forbids making images available as standalone downloadable files, which is precisely what the download demo does.) Task 2 leaves a documented seam for swapping in real photography later.

---

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `app/components/AppShell.vue` | The dashboard shell, moved out of `layouts/default.vue`. **The only `app/` change.** |
| `docs/site/app/layouts/demo.vue` | `<AppShell>` plus the persistent simulated-camera badge. |
| `docs/site/scripts/make-fixtures.mjs` | Deterministic ffmpeg fixture generation. |
| `docs/site/public/demo/fixtures/**` | Generated media (git-ignored; built on demand). |
| `docs/site/app/mocks/fixtures.ts` | The fixture manifest: camera paths, sizes, timestamps. |
| `docs/site/app/mocks/mockClient.ts` | `MockCameraTransport` — media, session, delete. |
| `docs/site/app/mocks/mockCommands.ts` | The protobuf command channel: settings + capture state. |
| `docs/site/app/mocks/presets.ts` | Named seed states for inline demo embeds. |
| `docs/site/app/plugins/mock-transport.client.ts` | Registers the mock. **Client-only, non-negotiable.** |
| `docs/site/app/components/content/Demo.vue` | MDC block embedding a screen or a single component. |

**Modified:** `app/layouts/default.vue` (becomes three lines), `docs/site/nuxt.config.ts` (fixture prebuild), `.gitignore`.

---

### Task 1: AppShell extraction and the demo layout

**Files:**

- Create: `app/components/AppShell.vue`
- Modify: `app/layouts/default.vue`
- Create: `docs/site/app/layouts/demo.vue`

**Interfaces:**

- Consumes: nothing.
- Produces: an `AppShell` component auto-imported from the layer, and a `demo` layout. Task 6 mounts `AppShell` inside inline embeds.

This is the **only** task permitted to touch `app/`. It exists because a Nuxt layout cannot be imported by name from another app, so the desktop shell must become a component before the docs site can mount it.

- [ ] **Step 1: Move the layout body into a component**

```bash
git mv app/layouts/default.vue app/components/AppShell.vue
```

The file needs **no content edits** — it already ends with `<slot />` inside `UDashboardGroup`, which is exactly what a shell component wants.

- [ ] **Step 2: Give the desktop app its layout back**

Create `app/layouts/default.vue`:

```vue
<template>
  <AppShell>
    <slot />
  </AppShell>
</template>
```

The desktop app's pages carry no `definePageMeta({ layout })`, so they must keep finding a layout named `default`.

- [ ] **Step 3: Verify the desktop app renders identically**

```bash
bun run test && bun run typecheck && bun run lint
bun run dev
```

Confirm the sidebar, nav, status chip and update banner all render as before, and that all five routes still resolve. A visual difference here is a bug — this step is a pure move.

- [ ] **Step 4: Build the demo layout**

Create `docs/site/app/layouts/demo.vue`. The badge must be visible on every demo screen and must not be dismissible:

```vue
<script setup lang="ts">
useSeoMeta({ robots: "noindex, nofollow" });
</script>

<template>
  <div class="relative">
    <AppShell>
      <slot />
    </AppShell>

    <div
      class="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center pb-3"
      role="status"
    >
      <span
        class="pointer-events-auto rounded-full bg-inverted/90 px-3 py-1.5 text-xs font-medium text-inverted shadow-lg backdrop-blur"
      >
        Simulated camera — live view and capture are pre-recorded
      </span>
    </div>
  </div>
</template>
```

Setting `robots` here also covers the `noindex` requirement for every `/demo/*` route in one place.

- [ ] **Step 5: Verify the demo routes pick up the shell**

```bash
bun run docs:generate
mkdir -p /tmp/demo-t1 && ln -sfn "$PWD/docs/site/.output/public" /tmp/demo-t1/insta360-luna-ultra-desktop
(cd /tmp/demo-t1 && python3 -m http.server 8201)
```

Load `/insta360-luna-ultra-desktop/demo/gallery`. Confirm the sidebar chrome now renders (it was bare before), the badge is visible, and the docs pages at `/docs/*` are **unaffected** — they must still use the docs layout, not the app shell.

- [ ] **Step 6: Commit**

```bash
git add app docs/site
git commit -m "feat(demo): extract AppShell and add the demo layout"
```

---

### Task 2: Generate media fixtures

**Files:**

- Create: `docs/site/scripts/make-fixtures.mjs`
- Create: `docs/site/app/mocks/fixtures.ts`
- Modify: `.gitignore`, `docs/site/package.json`

**Interfaces:**

- Consumes: nothing.
- Produces: `FIXTURE_PATHS: string[]` (camera-style absolute paths), `FIXTURE_SIZES: Record<string, number>`, and `fixtureUrl(cameraPath: string): string` from `app/mocks/fixtures.ts`. Tasks 3 and 5 consume all three.

Fixtures are generated, not committed — they are reproducible build artefacts and would otherwise add megabytes to the repo.

- [ ] **Step 1: Write the generator**

Create `docs/site/scripts/make-fixtures.mjs`. Filenames must satisfy `parseNameTimestamp` in `app/utils/lunaIndex.ts`, which matches `(?:VID|LRV|IMG|LIV|PIC|PANO)_(\d{8})_(\d{6})`:

```js
import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../public/demo/fixtures");

/**
 * Fixtures are generated rather than sourced from a stock library: it is
 * reproducible, needs no network, and carries no licence risk. The demo is
 * badged "simulated camera" throughout, so abstract imagery is honest.
 *
 * To swap in real photography later, drop JPEGs into public/demo/fixtures/
 * using these same filenames and skip this script — nothing else needs to change.
 */
const PHOTOS = [
  { name: "IMG_20260718_142012_00_001.jpg", w: 4000, h: 3000, hue: 210 },
  { name: "IMG_20260718_142530_00_002.jpg", w: 4000, h: 3000, hue: 24 },
  { name: "IMG_20260718_150114_00_003.jpg", w: 4000, h: 3000, hue: 145 },
  { name: "IMG_20260718_151902_00_004.jpg", w: 4000, h: 2250, hue: 280 },
  { name: "IMG_20260717_093305_00_005.jpg", w: 4000, h: 3000, hue: 12 },
  { name: "IMG_20260717_094410_00_006.jpg", w: 4000, h: 3000, hue: 190 },
  { name: "IMG_20260717_101207_00_007.jpg", w: 4000, h: 2250, hue: 45 },
  { name: "IMG_20260716_181522_00_008.jpg", w: 4000, h: 3000, hue: 320 },
  { name: "IMG_20260716_182044_00_009.jpg", w: 4000, h: 3000, hue: 95 },
  { name: "IMG_20260716_183310_00_010.jpg", w: 4000, h: 2250, hue: 260 },
];

const VIDEOS = [
  { name: "VID_20260718_143355_00_001.mp4", seconds: 6, hue: 200 },
  { name: "VID_20260717_100210_00_002.mp4", seconds: 4, hue: 30 },
];

/** Gradient + vignette reads as an abstract photograph rather than a test card. */
function photoFilter(w, h, hue) {
  return [
    `color=c=black:s=${w}x${h}`,
    `geq=r='128+100*sin(2*PI*(X/W+${hue / 360}))':g='128+90*sin(2*PI*(Y/H+${hue / 720}))':b='150+80*sin(2*PI*((X+Y)/(W+H)))'`,
    "vignette=PI/4",
    "noise=alls=6:allf=t",
  ].join(",");
}

async function generate() {
  await mkdir(outDir, { recursive: true });

  for (const p of PHOTOS) {
    const out = resolve(outDir, p.name);
    // ffmpeg's lavfi source builds the image entirely in-filter; -frames:v 1
    // takes a single frame out of the synthetic stream.
    await run("ffmpeg", [
      "-y", "-f", "lavfi",
      "-i", photoFilter(p.w, p.h, p.hue),
      "-frames:v", "1", "-q:v", "4", out,
    ]);
  }

  for (const v of VIDEOS) {
    const out = resolve(outDir, v.name);
    await run("ffmpeg", [
      "-y", "-f", "lavfi",
      "-i", `color=c=black:s=1920x1080:d=${v.seconds}:r=30`,
      "-vf", `geq=r='128+100*sin(2*PI*(X/W+T/4+${v.hue / 360}))':g='128+90*sin(2*PI*(Y/H+T/6))':b='150+80*sin(2*PI*((X+Y)/(W+H)-T/8))',vignette=PI/4`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", out,
    ]);
    // The camera pairs each clip with a low-res .lrv proxy; the gallery uses it
    // for thumbnails, and buildMediaItems drops the standalone proxy.
    await run("ffmpeg", [
      "-y", "-i", out, "-vf", "scale=640:-2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast",
      resolve(outDir, v.name.replace(/^VID_/, "LRV_")),
    ]);
  }

  // Live-view fixture: a raw H.264 Annex-B elementary stream at the camera's
  // real preview resolution. LiveView.vue's annexb path fetches this and feeds
  // it to WebCodecs, exercising splitNalUnits/drainAccessUnits for real.
  await run("ffmpeg", [
    "-y", "-f", "lavfi",
    "-i", "color=c=black:s=1280x960:d=30:r=30",
    "-vf", "geq=r='120+90*sin(2*PI*(X/W+T/5))':g='120+80*sin(2*PI*(Y/H-T/7))':b='140+70*sin(2*PI*((X-Y)/(W+H)+T/9))',vignette=PI/5,drawtext=text='SIMULATED PREVIEW':fontsize=48:fontcolor=white@0.55:x=(w-text_w)/2:y=h-120",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "baseline",
    "-g", "30", "-bf", "0", "-preset", "veryfast",
    "-f", "h264", resolve(outDir, "liveview.264"),
  ]);

  // Record real byte sizes so the mock reports what the gallery actually serves.
  const sizes = {};
  for (const name of [
    ...PHOTOS.map((p) => p.name),
    ...VIDEOS.map((v) => v.name),
    ...VIDEOS.map((v) => v.name.replace(/^VID_/, "LRV_")),
  ]) {
    sizes[name] = (await stat(resolve(outDir, name))).size;
  }
  await writeFile(resolve(outDir, "sizes.json"), JSON.stringify(sizes, null, 2));
  console.log(`generated ${Object.keys(sizes).length} fixtures in ${outDir}`);
}

await generate();
```

- [ ] **Step 2: Run it and check the output is sane**

```bash
node docs/site/scripts/make-fixtures.mjs
ls -la docs/site/public/demo/fixtures
du -sh docs/site/public/demo/fixtures
```

Expected: 10 JPEGs, 2 MP4s, 2 LRV MP4s, `liveview.264`, `sizes.json`. **Total must be under ~12 MB** — if the photos are much larger, lower `-q:v`. Open two JPEGs and one MP4 and confirm they are coherent images, not black frames or noise.

If any ffmpeg invocation fails, fix the filter graph rather than dropping the fixture — a missing fixture breaks Task 3.

- [ ] **Step 3: Write the manifest**

Create `docs/site/app/mocks/fixtures.ts`:

```ts
import sizes from "../../public/demo/fixtures/sizes.json";

/**
 * Camera-style absolute paths. The mock hands these to the app's real
 * `entriesFromPaths`/`buildMediaItems`, so the demo exercises the actual
 * index parser rather than constructing MediaItems directly.
 */
export const FIXTURE_PATHS: string[] = Object.keys(sizes)
  .map((name) => `/storage_internal/DCIM/Camera01/${name}`)
  .sort();

export const FIXTURE_SIZES: Record<string, number> = sizes;

/** Resolve a camera path to a real URL, honouring the deployed base path. */
export function fixtureUrl(cameraPath: string): string {
  const name = cameraPath.slice(cameraPath.lastIndexOf("/") + 1);
  return `${useRuntimeConfig().app.baseURL}demo/fixtures/${name}`;
}
```

`useRuntimeConfig().app.baseURL` is what makes this work on GitHub Pages — a hardcoded `/demo/fixtures/...` would 404 in production.

- [ ] **Step 4: Wire generation into the build and ignore the output**

In `docs/site/package.json`, add the script and chain it ahead of `dev` and `generate` alongside the existing feature sync:

```json
    "fixtures": "node scripts/make-fixtures.mjs",
```

Prepend `node scripts/make-fixtures.mjs && ` to both the `dev` and `generate` scripts, preserving the existing `sync-features` step.

Add to the root `.gitignore`:

```
docs/site/public/demo/fixtures
```

- [ ] **Step 5: Verify a clean build regenerates them**

```bash
rm -rf docs/site/public/demo/fixtures
bun run docs:generate
ls docs/site/.output/public/demo/fixtures | head
```

Confirm the fixtures were regenerated and copied into the build output, and that `docs:generate` exits 0.

- [ ] **Step 6: Commit**

```bash
git add docs/site .gitignore
git commit -m "feat(demo): generate media fixtures with ffmpeg"
```

---

### Task 3: The mock transport

**Files:**

- Create: `docs/site/app/mocks/mockClient.ts`
- Create: `docs/site/app/plugins/mock-transport.client.ts`

**Interfaces:**

- Consumes: `FIXTURE_PATHS`, `FIXTURE_SIZES`, `fixtureUrl` (Task 2); `CameraTransport`, `setCameraTransport` from `#layer/utils/transport`; `entriesFromPaths`, `buildMediaItems` from `#layer/utils/lunaIndex`.
- Produces: `createMockTransport(seed?: Partial<MockState>): CameraTransport` and the `MockState` type. Task 4 extends it with the command channel; Task 6 seeds it per-preset.

**The plugin must be `.client.ts`.** The transport registry is a process-global module variable and the docs site runs `ssr: true` — registering the mock on the server would leak one visitor's camera state into another's render. This is documented on the registry itself in `app/utils/transport.ts`; read that comment before starting.

- [ ] **Step 1: Write the mock**

Create `docs/site/app/mocks/mockClient.ts`:

```ts
import type { CameraInfo, LiveViewStats, MediaItem } from "#layer/types/media";
import type { CameraTransport } from "#layer/utils/transport";
import { buildMediaItems, entriesFromPaths } from "#layer/utils/lunaIndex";
import { FIXTURE_PATHS, FIXTURE_SIZES, fixtureUrl } from "./fixtures";

export interface MockState {
  /** Camera paths still "on" the camera; delete removes from here. */
  paths: string[];
  connected: boolean;
}

const INFO: CameraInfo = {
  host: "192.168.42.1",
  deviceName: "Luna Ultra (simulated)",
  serial: "DEMO-0000000",
  firmware: "1.0.238",
  ssid: "Luna Ultra.OSC",
};

/** Latency, so the UI's loading states are visible rather than instant. */
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createMockTransport(seed: Partial<MockState> = {}): CameraTransport {
  const state: MockState = {
    paths: seed.paths ?? [...FIXTURE_PATHS],
    connected: seed.connected ?? false,
  };

  return {
    get available() {
      return true;
    },

    async connect(): Promise<CameraInfo> {
      await delay(600);
      state.connected = true;
      return INFO;
    },

    async disconnect(): Promise<void> {
      state.connected = false;
    },

    async status(): Promise<CameraInfo | null> {
      return state.connected ? INFO : null;
    },

    async listMedia(): Promise<MediaItem[]> {
      await delay(400);
      // Deliberately shallow-faked: produce paths and let the app's real
      // parser build the items, so the demo exercises lunaIndex for real.
      const entries = entriesFromPaths(state.paths, fixtureUrl).map((entry) => ({
        ...entry,
        size: FIXTURE_SIZES[entry.name] ?? entry.size,
      }));
      const items = buildMediaItems(entries);
      items.sort((a, b) => b.takenAt - a.takenAt);
      return items;
    },

    async deleteFiles(cameraPaths: string[]): Promise<void> {
      await delay(300);
      const removing = new Set(cameraPaths);
      state.paths = state.paths.filter((path) => !removing.has(path));
    },

    async command(): Promise<Uint8Array> {
      // Task 4 replaces this with the real command state machine.
      return new Uint8Array(0);
    },

    async liveViewStart(): Promise<{ url: string; port: number }> {
      // Task 5 points this at the generated Annex-B fixture.
      throw new Error("Live view is not wired up yet.");
    },

    async liveViewStop(): Promise<void> {},

    async liveViewStats(): Promise<LiveViewStats> {
      return { bytes: 0, frames: 0, firstBytesHex: "", seconds: 0 };
    },

    async probeOscPreview(): Promise<string | null> {
      // Null forces the annexb path, which is what the fixture provides.
      return null;
    },

    fetch(url: string, init?: RequestInit): Promise<Response> {
      // Fixtures are ordinary static files; no health reporting is meaningful
      // for a mock, and the interface documents that implementations own it.
      return globalThis.fetch(url, init);
    },

    async probe(): Promise<boolean> {
      return state.connected;
    },

    async onDisconnect(): Promise<() => void> {
      return () => {};
    },
  };
}
```

Check `buildMediaItems`'s exact parameter list in `app/utils/lunaIndex.ts:130` before finalising — if it takes more than the entries array, pass what it needs rather than changing it.

- [ ] **Step 2: Register it from a client-only plugin**

Create `docs/site/app/plugins/mock-transport.client.ts`:

```ts
import { setCameraTransport } from "#layer/utils/transport";
import { createMockTransport } from "../mocks/mockClient";

/**
 * Client-only by necessity, not preference. The transport registry is a
 * process-global module variable; this site runs `ssr: true`, so registering
 * on the server would share one visitor's camera state with every concurrent
 * render. See the lifetime note in app/utils/transport.ts.
 */
export default defineNuxtPlugin(() => {
  setCameraTransport(createMockTransport());
});
```

- [ ] **Step 3: Verify the demo actually works**

```bash
bun run docs:generate
mkdir -p /tmp/demo-t3 && ln -sfn "$PWD/docs/site/.output/public" /tmp/demo-t3/insta360-luna-ultra-desktop
(cd /tmp/demo-t3 && python3 -m http.server 8203)
```

In a real browser, walk the demo:

- [ ] `/demo` shows the Connect screen and **Connect succeeds** (it previously said the desktop app was required).
- [ ] `/demo/gallery` lists the fixtures, grouped by day, with thumbnails rendering.
- [ ] Clicking a photo opens the full-screen preview with metadata.
- [ ] Multi-select works: click, shift-click a range, per-day select.
- [ ] **Download a photo with the watermark enabled** and confirm the downloaded file opens and carries the watermark. This is the headline claim — it must genuinely work.
- [ ] Delete a file: it disappears from the grid and does not return on refresh-within-session.
- [ ] The simulated-camera badge is visible throughout.
- [ ] The browser console is free of errors.

- [ ] **Step 4: Confirm SSR safety**

Grep the generated HTML for any pre-rendered demo state:

```bash
grep -l "DEMO-0000000" docs/site/.output/public -r || echo "no server-rendered mock state (correct)"
```

The serial must **not** appear in any prerendered HTML — if it does, the mock ran on the server and the plugin is not client-only.

- [ ] **Step 5: Commit**

```bash
git add docs/site
git commit -m "feat(demo): add the mock camera transport"
```

---

### Task 4: The protobuf command channel

**Files:**

- Create: `docs/site/app/mocks/mockCommands.ts`
- Modify: `docs/site/app/mocks/mockClient.ts` (delegate `command`)

**Interfaces:**

- Consumes: `MSG`, `encodeMessage`, `decodeMessage` from `#layer/utils/lunaProto`.
- Produces: `createCommandChannel(): (code: number, body: Uint8Array) => Promise<Uint8Array>`. Task 6's presets seed its settings state.

This is what makes the pro bar real: change ISO in the demo, and the read-back returns what you set.

- [ ] **Step 1: Read the real protocol code first**

Before writing anything, read `app/utils/lunaSettings.ts` and `app/utils/lunaCapture.ts`. They are the only callers of `command()`. Note the codes: `SET_OPTIONS = 7`, `GET_OPTIONS = 8`, `SET_PHOTOGRAPHY_OPTIONS = 9`, `GET_PHOTOGRAPHY_OPTIONS = 10`, `TAKE_PICTURE = 3`, `START_CAPTURE = 4`, `STOP_CAPTURE = 5`, `GET_CURRENT_CAPTURE_STATUS = 15`. Note exactly which message each expects back — the response type names are in `MSG` in `app/utils/lunaProto.ts`.

- [ ] **Step 2: Write the command channel**

Create `docs/site/app/mocks/mockCommands.ts`. Decode each request with the real schema and encode a real response, so `lunaSettings`'s decoding path runs unmodified:

```ts
import { decodeMessage, encodeMessage, MSG, type ProtoObject } from "#layer/utils/lunaProto";

const CODE_TAKE_PICTURE = 3;
const CODE_START_CAPTURE = 4;
const CODE_STOP_CAPTURE = 5;
const CODE_SET_OPTIONS = 7;
const CODE_GET_OPTIONS = 8;
const CODE_SET_PHOTOGRAPHY_OPTIONS = 9;
const CODE_GET_PHOTOGRAPHY_OPTIONS = 10;
const CODE_GET_CURRENT_CAPTURE_STATUS = 15;

/**
 * The real camera stores photography options per function-mode, so the mock
 * keys them the same way — otherwise a setting changed in one mode would
 * wrongly appear in another and the demo would teach the wrong model.
 */
export function createCommandChannel() {
  const options: ProtoObject = {};
  const perMode = new Map<string, ProtoObject>();
  let recording = false;
  let recordingStartedAt = 0;

  return async function command(code: number, body: Uint8Array): Promise<Uint8Array> {
    switch (code) {
      case CODE_SET_OPTIONS: {
        const request = decodeMessage(MSG.SetOptions, body);
        Object.assign(options, (request.value as ProtoObject | undefined) ?? {});
        return encodeMessage(MSG.SetOptionsResp, {});
      }

      case CODE_GET_OPTIONS:
        return encodeMessage(MSG.GetOptionsResp, { value: options });

      case CODE_SET_PHOTOGRAPHY_OPTIONS: {
        const request = decodeMessage(MSG.SetPhotographyOptions, body);
        const mode = String(request.function_mode ?? "unknown");
        const current = perMode.get(mode) ?? {};
        Object.assign(current, (request.value as ProtoObject | undefined) ?? {});
        perMode.set(mode, current);
        return encodeMessage(MSG.SetPhotographyOptionsResp, {});
      }

      case CODE_GET_PHOTOGRAPHY_OPTIONS: {
        const request = decodeMessage(MSG.GetPhotographyOptions, body);
        const mode = String(request.function_mode ?? "unknown");
        return encodeMessage(MSG.GetPhotographyOptionsResp, {
          value: perMode.get(mode) ?? {},
        });
      }

      case CODE_START_CAPTURE:
        recording = true;
        recordingStartedAt = Date.now();
        return new Uint8Array(0);

      case CODE_STOP_CAPTURE:
        recording = false;
        return new Uint8Array(0);

      case CODE_TAKE_PICTURE:
        return new Uint8Array(0);

      case CODE_GET_CURRENT_CAPTURE_STATUS:
        return encodeMessage(MSG.GetCurrentCaptureStatusResp, {
          status: {
            state: recording ? "NORMAL_CAPTURE" : "NOT_CAPTURE",
            capture_time: recording ? Math.floor((Date.now() - recordingStartedAt) / 1000) : 0,
          },
        });

      default:
        return new Uint8Array(0);
    }
  };
}
```

**The exact field names above are inferred from the response shapes `lunaSettings.ts` and `lunaCapture.ts` decode.** Verify each against `app/assets/luna-protocol-schema.json` and against how the caller reads it — for example `readCaptureStatus` pulls `status` then reads its state and seconds fields. If a field name differs, use the schema's, not this plan's.

- [ ] **Step 3: Delegate from the mock**

In `mockClient.ts`, import `createCommandChannel`, instantiate it once per transport, and replace the stub `command` with it.

- [ ] **Step 4: Verify the pro bar round-trips**

Serve statically as before and open `/demo/camera`:

- [ ] The pro bar renders with current values.
- [ ] Change ISO. Navigate away and back. **The new value is still shown** — this proves write-then-read-back through the real encode/decode path.
- [ ] Change a value in one capture mode, switch modes, and confirm the first mode's value did not leak into the second.
- [ ] Press record: the HUD timer starts and counts up; press stop and it stops.
- [ ] No console errors.

If a decode throws, the field names are wrong — fix them against the schema rather than catching the error.

- [ ] **Step 5: Commit**

```bash
git add docs/site
git commit -m "feat(demo): answer the protobuf command channel"
```

---

### Task 5: Live view

**Files:**

- Modify: `docs/site/app/mocks/mockClient.ts`

**Interfaces:**

- Consumes: the `liveview.264` fixture from Task 2.
- Produces: a working `liveViewStart`/`liveViewStats` pair.

`LiveView.vue` supports two transports: `mjpeg` (an `<img src>`) and `annexb` (a streamed `fetch` decoded by WebCodecs onto a canvas). `probeOscPreview` already returns `null`, so the annexb path is taken — and it fetches its URL with a plain `fetch`, which means a static `.264` file works with **no change to the app**.

- [ ] **Step 1: Serve the fixture as the stream**

In `mockClient.ts`, replace the throwing `liveViewStart` and the zeroed stats:

```ts
    async liveViewStart(): Promise<{ url: string; port: number }> {
      await delay(500);
      liveViewStartedAt = Date.now();
      return { url: `${useRuntimeConfig().app.baseURL}demo/fixtures/liveview.264`, port: 0 };
    },

    async liveViewStop(): Promise<void> {
      liveViewStartedAt = 0;
    },

    async liveViewStats(): Promise<LiveViewStats> {
      const seconds = liveViewStartedAt ? (Date.now() - liveViewStartedAt) / 1000 : 0;
      // Non-zero bytes matter: useLiveView surfaces an error if a stream
      // reports zero bytes after its first-byte timeout.
      return {
        bytes: Math.round(seconds * 240_000),
        frames: Math.round(seconds * 30),
        firstBytesHex: "00000001",
        seconds,
      };
    },
```

Declare `let liveViewStartedAt = 0;` alongside the other state in `createMockTransport`.

- [ ] **Step 2: Handle the end of the stream honestly**

The fixture is 30 seconds and finite; `consumeAnnexB` simply stops when the body ends. Do **not** modify `LiveView.vue` to loop it. Instead, note the behaviour in the demo layout's badge copy if it is not already covered, and confirm the canvas holds its last frame rather than going blank or erroring.

- [ ] **Step 3: Verify decoding actually happens**

Open `/demo/camera` in a browser that supports `VideoDecoder` (Chrome, Edge, Safari 16.4+, Firefox 130+):

- [ ] Start live view. The canvas shows moving video with the "SIMULATED PREVIEW" overlay burnt into the fixture.
- [ ] The HUD's diagnostics report a detected codec — this proves `detectCodec`/`splitNalUnits`/`drainAccessUnits` ran for real rather than being bypassed.
- [ ] No "accepted the command but sent no video" error appears.
- [ ] Stopping live view clears the canvas without throwing.

- [ ] **Step 4: Handle browsers without WebCodecs**

If `VideoDecoder` is undefined the canvas stays blank with no explanation. Confirm what actually happens in that case (you can simulate it by deleting `window.VideoDecoder` in the console before starting). If the result is a silent blank canvas, add a note in `layouts/demo.vue` — **not** in `LiveView.vue`, which is desktop-app source and off limits — explaining that live view needs a WebCodecs-capable browser.

- [ ] **Step 5: Commit**

```bash
git add docs/site
git commit -m "feat(demo): drive live view from an Annex-B fixture"
```

---

### Task 6: Inline demo embeds

**Files:**

- Create: `docs/site/app/mocks/presets.ts`
- Create: `docs/site/app/components/content/Demo.vue`
- Modify: `docs/site/content/docs/3.using-the-app.md`, `docs/site/app/pages/index.vue`

**Interfaces:**

- Consumes: `createMockTransport` (Task 3).
- Produces: a `::demo` MDC block usable in any content page.

This is the payoff the layer bought over an iframe: the component being documented runs inside the paragraph documenting it.

- [ ] **Step 1: Define the presets**

Create `docs/site/app/mocks/presets.ts`:

```ts
import type { MockState } from "./mockClient";
import { FIXTURE_PATHS } from "./fixtures";

/**
 * Named seed states, so a prose passage can open the demo already in the
 * situation it is describing.
 */
export const PRESETS: Record<string, Partial<MockState>> = {
  default: { connected: true },
  empty: { connected: true, paths: [] },
  selection: { connected: true, paths: FIXTURE_PATHS.slice(0, 6) },
  disconnected: { connected: false, paths: [] },
};

export function presetOrDefault(name?: string): Partial<MockState> {
  if (!name) return PRESETS.default!;
  const preset = PRESETS[name];
  if (!preset && import.meta.dev) console.warn(`[demo] unknown preset "${name}"`);
  return preset ?? PRESETS.default!;
}
```

- [ ] **Step 2: Build the MDC component**

Create `docs/site/app/components/content/Demo.vue`. It must be client-only — it mounts app components that assume a browser:

```vue
<script setup lang="ts">
const { screen, component, preset, height = 520 } = defineProps<{
  screen?: string;
  component?: string;
  preset?: string;
  height?: number;
}>();

const src = computed(() => {
  const base = useRuntimeConfig().app.baseURL;
  const path = `${base}demo${screen ? `/${screen}` : ""}`;
  // preset and component are read back by mock-transport.client.ts to seed
  // the mock; every prop must be consumed or oxlint fails on the unused one.
  const query = new URLSearchParams();
  if (preset) query.set("preset", preset);
  if (component) query.set("component", component);
  const suffix = query.size > 0 ? `?${query}` : "";
  return `${path}${suffix}`;
});
</script>

<template>
  <div class="my-6 overflow-hidden rounded-xl border border-default">
    <div class="flex items-center gap-1.5 border-b border-default bg-elevated px-3 py-2">
      <span class="size-2.5 rounded-full bg-error/60" />
      <span class="size-2.5 rounded-full bg-warning/60" />
      <span class="size-2.5 rounded-full bg-success/60" />
      <span class="ml-2 text-xs text-muted">Simulated camera</span>
    </div>

    <ClientOnly>
      <iframe
        :src
        :style="{ height: `${height}px` }"
        class="w-full border-0"
        loading="lazy"
        title="Luna Ultra Desktop demo"
      />
      <template #fallback>
        <div class="flex items-center justify-center" :style="{ height: `${height}px` }">
          <span class="text-sm text-muted">Loading demo…</span>
        </div>
      </template>
    </ClientOnly>
  </div>
</template>
```

**A note on the approach.** This embeds the demo route in an `<iframe>` rather than mounting the app's components directly into the prose. Direct mounting is the more elegant idea, but the app's screens assume they own the page: they mount a `UDashboardGroup` shell, register global state, and drive the router. Two of those on one page fight each other. The iframe gives each embed a clean document while still running the real components from the layer, and it keeps `preset` and `component` meaningful as query parameters. **If you can make direct mounting work cleanly, prefer it** — but do not ship a half-working version, and say which you did in your report.

If you keep the iframe, wire `preset` and `component` through as query parameters and have `mock-transport.client.ts` read them via `useRoute().query` to seed `createMockTransport(presetOrDefault(...))`.

- [ ] **Step 3: Embed one in the usage docs**

In `docs/site/content/docs/3.using-the-app.md`, after the multi-select prose, add:

```md
::demo{screen="gallery" preset="selection"}
::
```

- [ ] **Step 4: Embed one on the landing page**

In `docs/site/app/pages/index.vue`, add a section below the hero containing the same component with `screen="gallery"`. Keep it **below the fold** and lazily loaded so it cannot hurt the landing page's LCP — the page's SEO value is its prose, not its demo.

- [ ] **Step 5: Verify**

```bash
bun run docs:generate
```

Serve statically and confirm:

- [ ] The embed on `/docs/using-the-app` renders and is interactive.
- [ ] The landing page's embed loads lazily and does not block first paint.
- [ ] Docs pages still prerender as static HTML — view source and confirm the prose is present in the served HTML, not injected by JS.
- [ ] `sitemap.xml` still excludes `/demo/`, and demo pages still carry `noindex`.
- [ ] No console errors on either page.

- [ ] **Step 6: Commit**

```bash
git add docs/site
git commit -m "feat(demo): embed live demos inline in the documentation"
```

---

## Done

At the end of this plan:

- `/demo/*` runs the real app against a mock camera: browse, preview, multi-select, watermark, download and delete all genuinely work in a browser.
- Live view decodes a real H.264 elementary stream through the app's own WebCodecs path.
- The pro bar writes and reads back settings through the real protobuf encode/decode, keyed per function-mode like the real camera.
- Documentation prose can embed the real components inline.
- `app/` has exactly one change from this entire plan: `AppShell.vue`.
