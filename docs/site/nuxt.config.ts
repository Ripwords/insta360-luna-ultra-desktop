import { useNuxt } from "@nuxt/kit";
import { fileURLToPath } from "node:url";

export default defineNuxtConfig({
  // The desktop app at the repo root is the layer: its components,
  // composables, utils and pages are all available here, with no files moved.
  //
  // Note the trailing slash: `pathe`'s `extname()` (used by c12/Nuxt to
  // decide whether an `extends` entry is a directory or a config file)
  // returns "." for a path whose last segment is exactly "..", so a bare
  // `"../.."` gets misclassified as a file and fails to resolve at all
  // ("Cannot find module '../..'"). `"../../"` doesn't hit that code path
  // and resolves correctly. Verified in isolation with plain `pathe`, so
  // this is an upstream `pathe`/`c12` bug, not anything specific to this
  // repo — see task-1-report.md for the full trace.
  extends: ["../../"],

  alias: {
    // Cross-layer `~/...` imports don't work: `~` always resolves against
    // *this app's own* srcDir (docs/site/app), never the layer's, for both
    // types and values. `#layer` points at the layer's srcDir directly, and
    // Nuxt writes it into the generated tsconfig `paths`, so
    // `import { getCameraTransport } from "#layer/utils/transport"` and
    // `import type { CameraTransport } from "#layer/utils/transport"` both
    // resolve and typecheck. Auto-import still covers plain, unqualified
    // references (as CameraStatusChip's own auto-registration does); this
    // alias is for the cases — like an explicit type import — that
    // auto-import doesn't reach.
    "#layer": fileURLToPath(new URL("../../app", import.meta.url)),
  },

  // Nuxt's `css` config array is not layer-aware: the layer's own
  // `css: ["~/assets/css/main.css"]` entry merges verbatim into this app's
  // css list (`@nuxt/schema`'s `$resolve` for `css` only filters to
  // strings, it never absolutizes them), and the generated aggregator
  // template (`css.mjs`) imports each entry as-is. `~` for that virtual
  // module resolves against *this app's* srcDir (docs/site/app), not the
  // layer's (repo root's app/) — so it 404s. Rewrite just that one entry to
  // the real absolute path instead of copying the file.
  hooks: {
    "modules:done"() {
      const nuxt = useNuxt();
      nuxt.options.css = nuxt.options.css.map((entry) =>
        entry === "~/assets/css/main.css"
          ? fileURLToPath(new URL("../../app/assets/css/main.css", import.meta.url))
          : entry,
      );
    },
  },

  modules: ["@nuxt/content", "@nuxtjs/seo"],

  // Without this, @nuxt/content's build-time database probes for a driver
  // and — since `nuxt dev` runs under a Node subprocess even when launched
  // via `bun run`, so `process.versions.bun` is unset there — falls back to
  // an interactive "install better-sqlite3?" prompt that hangs non-TTY runs.
  // Node 24 ships `node:sqlite` natively, so use that instead of adding a
  // native-compiled dependency.
  content: {
    experimental: {
      sqliteConnector: "native",
    },
  },

  // The layer sets `ssr: false` for Tauri. The docs site is the opposite:
  // prose must prerender to static HTML or it cannot rank.
  ssr: true,

  app: {
    baseURL: "/luna-ultra-desktop/",
  },

  // Origin only — no path. `@nuxtjs/seo` combines `site.url` with
  // `app.baseURL` itself; including the path in both produces a
  // doubled-up prefix (`https://ripwords.github.io/luna-ultra-desktop/luna-ultra-desktop`)
  // in sitemap.xml and the canonical link tag. Origin-only + baseURL
  // produces the correct single-prefixed URLs.
  site: {
    url: "https://ripwords.github.io",
    name: "Luna Ultra Desktop",
  },

  // @nuxt/robots (bundled by @nuxtjs/seo) refuses to emit a robots.txt for
  // any non-root `app.baseURL` (the trigger is baseURL, not site.url) — a
  // build-time `logger.error` that self-disables robots.txt, not a runtime
  // throw. This is a permanent decision, not a workaround: a GitHub Pages
  // project site can only ever serve `/luna-ultra-desktop/robots.txt`,
  // which crawlers ignore — only `https://ripwords.github.io/robots.txt`
  // (repo root) is authoritative, and this site doesn't own that path.
  // robots.txt is out of scope for this site.
  robots: {
    robotsTxt: false,
  },

  compatibilityDate: "2026-06-30",
});
