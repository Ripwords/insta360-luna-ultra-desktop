# Docs Site & Live Component Demo — Design

Date: 2026-07-26
Status: approved, not yet implemented

## Goal

Ship an SEO-oriented documentation site at
`https://ripwords.github.io/luna-ultra-desktop/`, containing a landing page,
four user-facing doc pages, and an **interactive demo built from the app's real
components** — running in a plain browser against a mock camera, embeddable
inline in the documentation prose.

Two requirements pull in opposite directions and both must hold:

- The docs prose must be **server-rendered static HTML** so it ranks.
- The demo must be the **actual shipping components**, not a rebuild, so it
  never drifts from the app.

The design resolves this by extracting a Nuxt layer both apps extend, and
rendering the demo client-only inside otherwise-prerendered pages.

## Verdict: feasible, and the seam is unusually clean

Everything camera-facing funnels through two modules. There are seven
`@tauri-apps` import sites in the entire frontend, all dynamic and all behind
an `isTauri()` guard.

| Seam                          | Call sites                                                            | Demo substitute                        |
| ----------------------------- | --------------------------------------------------------------------- | -------------------------------------- |
| `lunaClient`                  | `useCamera`, `useGallery`, `useLiveView`, `lunaCapture`, `lunaSettings` | in-browser mock, fixture-backed        |
| `cameraFetch`                 | `CameraImage`, `PanoViewer`, `RawImage`, `WatermarkCanvas`, `useDownloads` | plain `fetch` at static fixture URLs |
| `saveBlob` / `isTauri`        | `app/utils/saveFile.ts`                                                | **already has an anchor-download fallback** |
| Tauri event `listen`          | `useCamera.watchDisconnect` only                                       | no-op                                  |
| updater                       | `useUpdater`                                                           | no-op                                  |

Everything else — all 22 components, the watermark engine, DNG/raw preview, the
protobuf codecs, selection logic, the Annex-B decoder — runs unmodified in a
browser. `bun run ui:dev` already boots the app in a browser today.

## Architecture

```
layers/camera/                    NEW — shared app layer
  nuxt.config.ts                    modules: @nuxt/ui; icon clientBundle
  app/
    components/                     moved from app/ (+ new AppShell.vue)
    composables/  utils/  types/  assets/
    pages/                          moved (index, camera, gallery, downloads, settings)
    app.config.ts                   moved

app/                              root Tauri app, now thin
  app.vue                           unchanged
  layouts/default.vue               <AppShell><slot /></AppShell>
  plugins/transport.client.ts       registers the real lunaClient

docs/site/                        NEW — the docs site
  nuxt.config.ts                    extends ../../layers/camera
  content/                          index.md + 4 doc pages
  app/
    layouts/default.vue             docs chrome (header, sidebar, TOC, footer)
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
and be verified before any file moves.

The codebase already uses an injectable-singleton pattern in
`app/utils/cameraHealth.ts:20-41`. This follows it exactly:

```ts
// layers/camera/app/utils/transport.ts
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
export const setCameraTransport = (t: CameraTransport) => { current = t };
export const useCameraTransport = (): CameraTransport => current;
```

Ten files swap `lunaClient.foo()` → `useCameraTransport().foo()`, and
`cameraFetch(url)` → `useCameraTransport().fetch(url)`.

**Desktop behaviour is unchanged by construction**: the default value is the
object those call sites already used. No plugin is required for the Tauri app
to keep working; `app/plugins/transport.client.ts` is added only for
explicitness.

Two Tauri touch-points do **not** belong to the transport and need separate
handling, or the demo will import Tauri modules in a plain browser and throw:

- **`useCamera.watchDisconnect`** currently calls
  `import("@tauri-apps/api/event")` directly, guarded by `lunaClient.available`.
  Since the mock reports `available: true`, that guard is not enough. The listener
  moves behind `transport.onDisconnect()`; the real client wraps `listen`, the
  mock returns a no-op unlisten.
- **`useUpdater`** must be guarded by `isTauri()`, not by transport
  availability. In the demo it is a no-op and renders no update banner.

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

### Verification gate

`bun x vitest run`, `bun run typecheck`, `bun run lint`, then the app driven
against `luna_mock_server/` — connect, list media, download, delete — before
Step 2 begins.

## Step 2 — Layer extraction

Pure file moves. No logic edits. Two decisions worth recording:

**Layouts.** `app/layouts/default.vue`'s body becomes
`layers/camera/app/components/AppShell.vue`. Each consumer then writes its own
three-line layout wrapping it. This avoids relying on layout-name precedence
between layer and project, which would otherwise make the layer's `default`
layout hijack every docs page.

**Routes.** The layer owns `pages/`, so the root app keeps `/`, `/camera`,
`/gallery`, `/downloads`, `/settings` exactly as now. The docs site adds a
`pages:extend` hook re-prefixing layer-sourced routes (detected by file path)
to `/demo/*`, so they cannot collide with docs routes.

## Step 3 — Docs site and SEO

`@nuxt/content` v3 for content, `@nuxtjs/seo` for the SEO surface: sitemap,
robots, canonicals, satori-rendered OG images (no headless browser at build
time), and JSON-LD — including `SoftwareApplication` on the landing page, which
is what earns rich results for a downloadable app.

Pages, sourced from README content:

| Page                     | Content                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| Landing                  | Hero, download buttons per OS, feature sections, embedded demo                                   |
| Install & first run      | Per-OS download; macOS quarantine/`xattr`, Local Network permission; Windows SmartScreen; Linux AppImage/FUSE |
| Connecting to the camera | Joining the camera Wi-Fi, Connect screen, auto-reconnect, troubleshooting                        |
| Using the app            | Viewfinder + HUD, pro bar, gallery, multi-select, downloads/watermark, delete, 3D showpiece, themes |
| Feature status           | Shipped / gated / on hold                                                                        |

**Feature status has one source of truth.** A prebuild script copies
`docs/FEATURES.md` into `docs/site/content/` rather than duplicating it.

Rendering: docs prose prerenders to static HTML. The demo is wrapped in
`<ClientOnly>` and marked `noindex` — it is client-rendered app chrome, and
indexing it would pollute results with UI strings instead of prose.

### Deployment

`.github/workflows/docs.yml`, on push to `master`:

```
bun install --frozen-lockfile
NUXT_APP_BASE_URL=/luna-ultra-desktop/ bun run --cwd docs/site generate
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

| Asset            | Spec                                                       |
| ---------------- | ---------------------------------------------------------- |
| Photos           | ~16, WebP, ~150 KB each, Luna-convention filenames          |
| Video clips      | 2–3, five seconds, 720p, ~500 KB each                       |
| Live-view stream | one `.264` Annex-B elementary stream, 1280×960, ~60 s       |
| 3D model         | STL → Draco-compressed GLB, ~2–4 MB                         |

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

| Risk                                                              | Mitigation                                                                          |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Transport refactor regresses the shipping app                     | Default value is the existing `lunaClient`; new tests; verified against mock server before Step 2 |
| Layer/project layout precedence hijacks docs pages                 | Shell is a component, not a layout; each app writes its own explicit layout          |
| Layer routes collide with docs routes                              | `pages:extend` prefixes layer-sourced routes to `/demo/*`                            |
| `ssr: false` in the layer leaks into the docs site                 | Docs site sets `ssr: true`; demo wrapped in `<ClientOnly>`                           |
| Icon `clientBundle: { scan: true }` inflates the docs bundle       | Measure; scope the scan to the layer if needed                                       |
| Demo JS weight hurts landing-page LCP                              | Demo is client-only and below the fold; prose prerenders                             |
| `baseURL` breaks fixture and asset paths                           | All fixture URLs built through the runtime base URL, never hardcoded                 |

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
