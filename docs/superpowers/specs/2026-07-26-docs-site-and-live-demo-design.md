# Docs Site & Live Component Demo — Design

Date: 2026-07-26
Status: approved, not yet implemented

## Goal

Ship an SEO-oriented documentation site at
`https://ripwords.github.io/insta360-luna-ultra-desktop/`, containing a landing page,
four user-facing doc pages, and an **interactive demo built from the app's real
components** — running in a plain browser against a mock camera, embeddable
inline in the documentation prose.

Two requirements pull in opposite directions and both must hold:

- The docs prose must be **server-rendered static HTML** so it ranks.
- The demo must be the **actual shipping components**, not a rebuild, so it
  never drifts from the app.

The design resolves this by having the docs site consume the desktop app as a
Nuxt layer, and rendering the demo client-only inside otherwise-prerendered
pages.

**Revision, 2026-07-26.** An earlier draft extracted the shared UI into a
dedicated `layers/camera/` directory that both apps would extend. That is
cancelled: a Nuxt layer needs only a `nuxt.config.ts`, so the repo root is
already a valid layer, and the docs site can declare `extends: ["../.."]` to
consume the desktop app **in place, with zero files moved**. Route collisions and
layout precedence are solved from the docs side either way. This keeps the
desktop app's tree untouched, which is the point.

## Verdict: feasible, and the seam is unusually clean

Everything camera-facing funnels through two modules. There are seven
`@tauri-apps` import sites in the entire frontend, all dynamic and all behind
an `isTauri()` guard.

| Seam                   | Call sites                                                                 | Demo substitute                             |
| ---------------------- | -------------------------------------------------------------------------- | ------------------------------------------- |
| `lunaClient`           | `useCamera`, `useGallery`, `useLiveView`, `lunaCapture`, `lunaSettings`    | in-browser mock, fixture-backed             |
| `cameraFetch`          | `CameraImage`, `PanoViewer`, `RawImage`, `WatermarkCanvas`, `useDownloads` | plain `fetch` at static fixture URLs        |
| `saveBlob` / `isTauri` | `app/utils/saveFile.ts`                                                    | **already has an anchor-download fallback** |
| Tauri event `listen`   | `useCamera.watchDisconnect` only                                           | no-op                                       |
| updater                | `useUpdater`                                                               | no-op                                       |

Everything else — all 22 components, the watermark engine, DNG/raw preview, the
protobuf codecs, selection logic, the Annex-B decoder — runs unmodified in a
browser. `bun run ui:dev` already boots the app in a browser today.

## Architecture

```
nuxt.config.ts                    UNCHANGED — the repo root is the layer
app/                              UNCHANGED except for one extraction:
  components/AppShell.vue           NEW — the dashboard shell, formerly the
                                    body of layouts/default.vue
  layouts/default.vue               now <AppShell><slot /></AppShell>
  components/ composables/ utils/   stay exactly where they are
  types/ assets/ pages/ workers/    stay exactly where they are

docs/site/                        NEW — the docs site
  nuxt.config.ts                    extends ["../.."]; ssr: true; baseURL
  content/                          index.md + 4 doc pages
  app/
    layouts/default.vue             docs chrome — shadows the app's for docs pages
    layouts/demo.vue                <AppShell> + persistent "simulated camera" banner
    components/content/Demo.vue     MDC block for inline live components
    mocks/mockClient.ts             the fake camera
    plugins/transport.client.ts     registers mockClient
  public/demo/fixtures/             photos, clips, live-view stream, luna-ultra.glb
```

`docs/FEATURES.md` and `docs/superpowers/` are untouched. README links to
`docs/FEATURES.md` keep working.

## Step 1 — Transport seam

Isolated, independently verifiable, contains no demo code. This step must land
and be verified against a real camera session before the docs site is built on
top of it.

The codebase already uses an injectable-singleton pattern in
`app/utils/cameraHealth.ts:20-41`. This follows it exactly:

```ts
// app/utils/transport.ts
export interface CameraTransport {
  readonly available: boolean;
  connect(host: string): Promise<CameraInfo>;
  disconnect(): Promise<void>;
  status(): Promise<CameraInfo | null>;
  listMedia(host: string): Promise<MediaItem[]>;
  deleteFiles(paths: string[]): Promise<void>;
  command(code: number, body: Uint8Array): Promise<Uint8Array>;
  liveViewStart(): Promise<{ url: string; port: number }>;
  liveViewStop(): Promise<void>;
  liveViewStats(): Promise<LiveViewStats>;
  probeOscPreview(host: string): Promise<string | null>;
  /** Replaces `cameraFetch`, health reporting included. */
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** Replaces `probeCamera`; deliberately bypasses health reporting. */
  probe(host: string): Promise<boolean>;
  /** Replaces the direct Tauri event listener; returns an unlisten fn. */
  onDisconnect(handler: () => void): Promise<() => void>;
}

let current: CameraTransport = lunaClient; // real client is the DEFAULT
export const setCameraTransport = (t: CameraTransport) => {
  current = t;
};
export const useCameraTransport = (): CameraTransport => current;
```

Ten files swap `lunaClient.foo()` → `useCameraTransport().foo()`, and
`cameraFetch(url)` → `useCameraTransport().fetch(url)`.

**Desktop behaviour is unchanged by construction**: the default value is the
object those call sites already used. The desktop app therefore needs no plugin
and no registration call at all — only the docs-site demo registers a transport.

Two Tauri touch-points do **not** belong to the transport and need separate
handling, or the demo will import Tauri modules in a plain browser and throw:

- **`useCamera.watchDisconnect`** currently calls
  `import("@tauri-apps/api/event")` directly, guarded by `lunaClient.available`.
  Since the mock reports `available: true`, that guard is not enough. The listener
  moves behind `transport.onDisconnect()`; the real client wraps `listen`, the
  mock returns a no-op unlisten.
- **`useUpdater`** needs no change. It is already guarded by `isTauri()`:
  `check()` returns early, `install()` can only run from a `pending` that only
  `check()` sets, and `available` is `computed(() => isTauri())`. In the demo it
  is already a no-op and renders no update banner.

### Testing

Per the TDD convention in CLAUDE.md, tests come first. The existing 17 vitest
files cover pure utils only — none touch `lunaClient`, so nothing existing can
break, but nothing existing protects this either. This step adds:

- `tests/transport.test.ts` — registry default, override, reset.
- `tests/useCamera.test.ts` — connect / disconnect / reconnect / library refresh
  driven against a fake transport.
- `tests/useGallery.test.ts` — delete path calls `deleteFiles` with camera paths.
- `tests/useLiveView.test.ts` — OSC probe preferred, annexb fallback, stop.

This is coverage the project does not have today and cannot get without the
seam, since the camera path currently requires hardware or the mock server.

**A Nuxt test environment must be added first.** `vitest.config.ts` runs
`environment: "node"` with only a `~` → `./app` alias; composables calling
`useState`, `computed` or `useToast` cannot run under it. The composable tests
above require `@nuxt/test-utils`, `@vue/test-utils` and `happy-dom` as
devDependencies, plus a second vitest config for `environment: "nuxt"`. The pure
registry test runs under the existing node project unchanged.

### Verification gate

`bun x vitest run`, `bun run typecheck`, `bun run lint`, then the app driven
against `luna_mock_server/` — connect, list media, download, delete — before
Step 2 begins.

## Step 2 — Consume the app as a layer

**No files move.** `docs/site/nuxt.config.ts` declares `extends: ["../.."]` and
inherits the desktop app's components, composables, utils, types and pages
directly. The root's `ssr: false` and Tauri-specific Vite settings are overridden
by the child config, which sets `ssr: true`.

Three consequences, all handled from the docs side:

**Layouts.** The app's `layouts/default.vue` would otherwise become the docs
site's default layout too. The docs site defines its own `app/layouts/default.vue`,
and project-level layouts take precedence over layer-level ones, so docs pages get
docs chrome. Demo pages opt into `layouts/demo.vue` instead.

**The shell.** A layout cannot be imported by name from another app, so the
sidebar shell must be reachable as a component. This is the **only** change to
`app/`: the body of `layouts/default.vue` moves into
`app/components/AppShell.vue`, and the layout becomes
`<AppShell><slot /></AppShell>`. Two files, no behaviour change, and the desktop
app renders identically.

**Routes.** The app's `pages/` are inherited, so `/`, `/camera`, `/gallery`,
`/downloads`, `/settings` would collide with docs routes. The docs site adds a
`pages:extend` hook re-prefixing layer-sourced routes (detected by file path) to
`/demo/*` and stamping `meta.layout = "demo"` on them. The desktop app is
unaffected — it keeps those routes at the root.

**Risk.** Extending the repo root is less conventional than a dedicated layer
directory, and dependency resolution for a nested `docs/site` package is a known
friction point with Nuxt layers. If it fights, the fallback is a Bun workspace so
dependencies hoist — not a file move.

## Step 3 — Docs site and SEO

`@nuxt/content` v3 for content, `@nuxtjs/seo` for the SEO surface: sitemap,
robots, canonicals, satori-rendered OG images (no headless browser at build
time), and JSON-LD — including `SoftwareApplication` on the landing page, which
is what earns rich results for a downloadable app.

Pages, sourced from README content:

| Page                     | Content                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Landing                  | Hero, download buttons per OS, feature sections, embedded demo                                                |
| Install & first run      | Per-OS download; macOS quarantine/`xattr`, Local Network permission; Windows SmartScreen; Linux AppImage/FUSE |
| Connecting to the camera | Joining the camera Wi-Fi, Connect screen, auto-reconnect, troubleshooting                                     |
| Using the app            | Viewfinder + HUD, pro bar, gallery, multi-select, downloads/watermark, delete, 3D showpiece, themes           |
| Feature status           | Shipped / gated / on hold                                                                                     |

**Feature status has one source of truth.** A prebuild script copies
`docs/FEATURES.md` into `docs/site/content/` rather than duplicating it.

Rendering: docs prose prerenders to static HTML. The demo is wrapped in
`<ClientOnly>` and marked `noindex` — it is client-rendered app chrome, and
indexing it would pollute results with UI strings instead of prose.

### Deployment

`.github/workflows/docs.yml`, on push to `master`:

```
bun install --frozen-lockfile
NUXT_APP_BASE_URL=/insta360-luna-ultra-desktop/ bun run --cwd docs/site generate
touch docs/site/.output/public/.nojekyll
actions/upload-pages-artifact → actions/deploy-pages
```

One-time manual step: set Pages source to "GitHub Actions" in repo settings.

## Step 4 — Mock camera and fixtures

The mock is deliberately **shallow-faked** — it fakes the wire, not the logic:

- `listMedia` produces raw camera **paths**, which the real `entriesFromPaths`
  and `buildMediaItems` then parse. The demo exercises the actual index parser.
  Fixture filenames must satisfy `lunaIndex.ts` parsing (note: 360-style
  `IMG_*.jpg` files are 2:1 and carry no metadata).
- `command(code, body)` is an in-memory state machine that decodes the request
  and encodes real protobuf responses using the existing `protobuf.ts`. Changing
  ISO in the pro bar genuinely writes and reads back. Settings options are
  stored per function-mode, matching the real camera.
- `deleteFiles` removes from the in-memory list.
- `probeOscPreview` returns `null`, so live view takes the annexb path.

### Live view

`LiveView.vue` supports two transports: `mjpeg` (a plain `<img :src>`) and
`annexb` (WebCodecs `VideoDecoder`, fed by a streamed `fetch`, painted to
canvas). The demo uses **annexb** with a static H.264 Annex-B elementary stream
fixture at 1280×960 — the real preview resolution — served straight from
`public/`. `consumeAnnexB` reads it via `response.body.getReader()`, so a static
file works without any change to shipping code, and the demo exercises
`splitNalUnits`, `detectCodec`, `drainAccessUnits` and the decoder for real.

Two consequences, both accepted:

- **The stream ends.** A static file plays once. The demo ships a ~60s fixture
  and surfaces a "replay" affordance when the read completes. A Service Worker
  serving an infinite concatenated stream is a possible later upgrade; it is not
  in scope, and its scope path would need to sit under the Pages base URL.
- **`VideoDecoder` is not universal.** Supported in Chrome/Edge, Safari 16.4+,
  Firefox 130+. Where it is absent, the demo shows a poster frame and a note
  rather than an empty canvas.

### Fixtures

Budget ≈ 8 MB total, licensed from Pexels / Unsplash / Pixabay / CC0.

**iStock is explicitly rejected**: it is Getty's paid library, and its limited
free selection ships under the iStock Content License, which forbids making
images available as standalone downloadable files. Since downloading files is
the demo's headline feature, that license is disqualifying.

| Asset            | Spec                                                  |
| ---------------- | ----------------------------------------------------- |
| Photos           | ~16, WebP, ~150 KB each, Luna-convention filenames    |
| Video clips      | 2–3, five seconds, 720p, ~500 KB each                 |
| Live-view stream | one `.264` Annex-B elementary stream, 1280×960, ~60 s |
| 3D model         | STL → Draco-compressed GLB, ~2–4 MB                   |

The GLB feeds the glTF path `LunaModel.vue:139` already has, so the 61 MB
`public/Insta360+LunaUltra.stl` is never shipped to the web.

**No DNG fixture.** Real Luna DNGs are 20 MB+ of raw Bayer with no embedded
preview, so demoing `rawPreview.ts` would cost more payload than every other
fixture combined. The demo shows JPEGs only.

### Honesty

Every demo screen carries a persistent "simulated camera" badge. Live view and
capture are simulated; gallery, preview, multi-select, watermark compositing and
download are genuinely real, running the shipping code end-to-end in the
browser.

## Inline demo components

The payoff of the layer over an iframe: MDC lets documentation embed live app
components in the prose that explains them.

```md
Shift-click selects a range — try it:

::demo{screen="gallery" preset="selection"}
::
```

`Demo.vue` resolves either a whole `screen` (a layer page in the demo layout) or
a single `component`, mounts it client-only against the mock transport, and
frames it in desktop-window chrome.

A `preset` is a **named seed state in the mock** — a starting library, selection,
connection status and settings snapshot — so a prose passage can open the demo
already in the state it is describing. Presets are declared in one map beside
`mockClient.ts`; an unknown preset name falls back to the default state and warns
in dev.

## Risks

| Risk                                                         | Mitigation                                                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Transport refactor regresses the shipping app                | Default value is the existing `lunaClient`; new tests; verified against mock server before Step 2 |
| Layer/project layout precedence hijacks docs pages           | Shell is a component, not a layout; each app writes its own explicit layout                       |
| Layer routes collide with docs routes                        | `pages:extend` prefixes layer-sourced routes to `/demo/*`                                         |
| `ssr: false` in the layer leaks into the docs site           | Docs site sets `ssr: true`; demo wrapped in `<ClientOnly>`                                        |
| Icon `clientBundle: { scan: true }` inflates the docs bundle | Measure; scope the scan to the layer if needed                                                    |
| Demo JS weight hurts landing-page LCP                        | Demo is client-only and below the fold; prose prerenders                                          |
| `baseURL` breaks fixture and asset paths                     | All fixture URLs built through the runtime base URL, never hardcoded                              |

## Out of scope

- Dev/protocol documentation (the site is landing + user docs).
- A custom domain — deferred; the project-page base URL is assumed throughout.
- Service-Worker-backed infinite live-view looping.
- DNG / RAW preview in the demo.
- Replacing `luna_mock_server/`; it remains the Node-side mock for development.

## Build order

1. Transport seam + tests. Verify against `luna_mock_server/`. **Gate.**
2. Layer extraction (file moves only). Verify the Tauri app still builds and runs.
3. Docs site scaffold, content, SEO, Pages workflow. Ship it — useful on its own.
4. Mock transport + fixtures + inline demo components.

Steps 1 and 2 leave the project better off even if 3 and 4 are never finished.

This is large enough to warrant **two implementation plans**: steps 1–2 (a
refactor of the shipping app, gated on device/mock verification) and steps 3–4
(new, additive work that cannot regress the app). The second plan depends on the
first only through the `CameraTransport` interface.
