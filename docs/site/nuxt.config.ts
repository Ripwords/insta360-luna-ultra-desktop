import { useNuxt } from "@nuxt/kit";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

// nuxt-og-image (bundled by @nuxtjs/seo) imports the bare `h3` specifier
// without declaring it as its own dependency. This workspace's flat
// dependency store also contains h3@2.0.1-rc.20 — pulled in as a pinned
// devDependency of @nuxt/test-utils (`h3-next`), unrelated to this app —
// and Bun's hoisting elects that newer major version for any *undeclared*
// "h3" import. h3 2.x dropped the `sendError` export nuxt-og-image needs,
// so every request 500'd with "does not provide an export named
// 'sendError'". Force the server bundle to resolve `h3` the same way
// nitropack does (it correctly depends on `h3: ^1.15.11`), instead of
// letting the ambiguous bare specifier fall through to the wrong version.
const h3Path = require.resolve("h3", {
  paths: [dirname(require.resolve("nitropack/package.json"))],
});

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
    h3: h3Path,
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

    // `extends` also inherits every OTHER page from the desktop app
    // (camera/gallery/downloads/settings) since docs/site doesn't override
    // them. `camera`/`gallery`/`downloads` transitively import
    // worker-bundled code (e.g. `watermark.worker.ts` via the layout's old
    // download-progress indicator) whose cross-layer "~" imports don't
    // survive Vite's isolated worker sub-build, which broke `nuxt
    // generate` outright (the client build statically discovers every
    // registered route, worker included, regardless of whether it is ever
    // prerendered). `/settings` is kept: `CameraStatusChip` (used on the
    // probe page) always links there, and settings.vue doesn't touch the
    // watermark worker. Deciding which inherited routes docs/site should
    // actually serve long-term is Task 2's job ("route re-prefixing and
    // docs layout"); for this gate, keep only what docs/site needs so the
    // `generate` run isn't blocked by pages this task never asked for.
    "pages:extend"(pages) {
      const docsSiteDir = fileURLToPath(new URL(".", import.meta.url));
      for (let i = pages.length - 1; i >= 0; i--) {
        const page = pages[i];
        if (page?.path !== "/settings" && !page?.file?.startsWith(docsSiteDir)) pages.splice(i, 1);
      }
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

  site: {
    url: "https://ripwords.github.io/luna-ultra-desktop",
    name: "Luna Ultra Desktop",
  },

  // @nuxt/robots (bundled by @nuxtjs/seo) refuses to generate a robots.txt
  // when `site.url` carries a path, which it does here for a GitHub Pages
  // project site — it throws mid-request, which crashed every route with a
  // 500. Real robots/sitemap output is Task 4's job; disable it for now.
  robots: {
    robotsTxt: false,
  },

  compatibilityDate: "2026-06-30",
});
