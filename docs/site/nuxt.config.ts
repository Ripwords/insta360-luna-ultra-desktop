import { useNuxt } from "@nuxt/kit";
import { fileURLToPath } from "node:url";

// Shared with `app.baseURL` below and with the `routeRules` redirect targets,
// so the two can never drift out of sync.
//
// The repo was renamed to `insta360-luna-ultra-desktop` (the old
// `luna-ultra-desktop` name now only resolves via a GitHub 301), so this is
// the actual path segment GitHub Pages serves the project site under:
// https://ripwords.github.io/insta360-luna-ultra-desktop/.
const baseURL = "/insta360-luna-ultra-desktop/";

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

    // Routes inherited from the desktop-app layer live under /demo/* so they
    // cannot collide with docs routes. Identified by file path: the layer's
    // pages resolve to the repo root's app/pages, not this app's.
    //
    // This only walks the flat top-level array, never `page.children`. That
    // is safe today because all five layer pages (index, camera, gallery,
    // downloads, settings) are flat top-level routes with no nesting — but a
    // future nested layer route would silently stay unprefixed. Revisit with
    // a recursive walk if the layer ever grows nested pages.
    "pages:extend"(pages) {
      const isFromLayer = (file?: string) =>
        !!file && file.includes("/app/pages/") && !file.includes("/docs/site/");

      for (const page of pages) {
        if (!isFromLayer(page.file)) continue;
        page.path = page.path === "/" ? "/demo" : `/demo${page.path}`;
        page.name = page.name ? `demo-${page.name}` : undefined;
        page.meta = { ...page.meta, layout: "demo", robots: "noindex, nofollow" };
      }

      // Nuxt's layer-merge page scan deduplicates the `/` collision between
      // the layer's `app/pages/index.vue` and this app's own
      // `app/pages/index.vue` *before* this hook runs — only this app's
      // index survives into `pages`, so the loop above never sees the
      // layer's Connect page and has nothing to rename. Re-add it here,
      // pointing straight at the layer's file, so `/demo` still resolves.
      pages.push({
        name: "demo",
        path: "/demo",
        file: fileURLToPath(new URL("../../app/pages/index.vue", import.meta.url)),
        meta: { layout: "demo" },
      });
    },
  },

  // The layer's pages hardcode absolute links (`to="/gallery"` etc.) that
  // assume the desktop app's root-level routing. Rather than editing the
  // desktop app (an explicit project decision — the app must not be modified
  // for the docs site's benefit), redirect the unprefixed paths to their
  // /demo equivalents. `/` is deliberately absent: it must stay the landing
  // page, not redirect anywhere.
  //
  // The targets MUST carry the base path. `nuxt generate` bakes these into
  // static meta-refresh stubs and emits the target verbatim — there is no
  // server on GitHub Pages to correct a root-relative one, so `/demo/camera`
  // would 404 while `/insta360-luna-ultra-desktop/demo/camera` resolves. (A root-
  // relative target only "works" under `nuxt preview`'s Nitro server, which
  // silently issues its own corrective redirect — that server doesn't exist
  // in the static-hosting production topology, so it can't be trusted as a
  // verification target here.)
  routeRules: {
    "/camera": { redirect: `${baseURL}demo/camera` },
    "/gallery": { redirect: `${baseURL}demo/gallery` },
    "/downloads": { redirect: `${baseURL}demo/downloads` },
    "/settings": { redirect: `${baseURL}demo/settings` },
  },

  modules: ["@nuxt/content", "@nuxtjs/seo"],

  sitemap: {
    // /demo/* is client-rendered app chrome inherited from the desktop-app
    // layer, not prose — keep it out of search results. There is no
    // robots.txt for a project-page baseURL (see the `robots` config below),
    // so this exclusion plus the per-route `noindex` meta tag set in the
    // `pages:extend` hook above is what actually keeps /demo/* out.
    //
    // Both a bare and a baseURL-prefixed form are listed because by the time
    // `@nuxtjs/sitemap`'s exclude filter runs, each candidate URL has already
    // been resolved to its final absolute form and only had its origin
    // stripped back off (`createPathFilter` in `dist/runtime/utils-pure.js`
    // does `parseURL(loc).pathname`) — so the string actually being matched
    // is `/insta360-luna-ultra-desktop/demo/camera`, not `/demo/camera`.
    // A bare `/demo/**` glob never matches that (confirmed empirically:
    // with only the bare pattern present, /demo/* URLs still made it into
    // `sitemap.xml`), so the baseURL-prefixed form is the one doing the
    // actual work; the bare form is kept too in case a future zero-runtime
    // or non-prerendered code path in this module ever filters on the
    // pre-absolute relative path instead.
    //
    // The third entry excludes one specific phantom URL rather than a
    // pattern class — see the long comment below for why this, and not a
    // broader config change, is the fix.
    exclude: ["/demo/**", `${baseURL}demo/**`, `${baseURL}${baseURL.slice(1, -1)}`],

    // --- Diagnosis of the doubled-baseURL phantom sitemap entry ---
    //
    // `nuxt generate`'s Nitro prerenderer crawls every rendered page for
    // `href` attributes and queues each discovered one as an additional
    // route (`nitropack/dist/core/index.mjs`'s `extractLinks`/`generateRoute`
    // — pushes the raw href straight into the crawl queue, no baseURL
    // handling). Internal links are rendered by Vue Router with
    // `app.baseURL` already baked into the `href` (ordinary, correct
    // behaviour) — but that means the site's own logo/title link back to
    // "/", present in the header on every page, renders as
    // `href="/insta360-luna-ultra-desktop/"`. Nitro treats that discovered
    // string as a *literal, distinct route* to crawl and render, alongside
    // "/" itself — confirmed by running with `sitemap.debug: true`, whose
    // "Prerendered routes:" log lists both `{ loc: '/' }` and
    // `{ loc: '/insta360-luna-ultra-desktop/' }` as separate entries.
    //
    // `@nuxtjs/sitemap` records that duplicate route's raw path verbatim as
    // a sitemap `loc` (its "nuxt:prerender" source, built from whatever
    // Nitro actually rendered — this is the *only* source most routes have
    // in a full static generate; Nuxt's static-page-scan source ("nuxt:pages")
    // defers to it for anything Nitro already rendered, which in `nuxt
    // generate` is everything, so "nuxt:prerender" cannot be disabled
    // wholesale without losing "/", "/demo", and "/demo/*" from the sitemap
    // too — confirmed by testing: doing so dropped every entry except the
    // ones from `content.config.ts`'s explicit source).
    //
    // When building the final absolute URL, the module's own dedup logic
    // (`resolveSitePath`, in the `site-config-stack` package) is *supposed*
    // to catch exactly this: it checks whether `loc` already starts with
    // `app.baseURL` and strips it before prefixing again. But
    // `preNormalizeEntry` (`@nuxtjs/sitemap/dist/runtime/server/sitemap/
    // urlset/normalise.js`) strips `loc`'s trailing slash *before* that
    // check runs. For every other crawled duplicate (e.g. the equally
    // baseURL-prefixed `/insta360-luna-ultra-desktop/docs/install`, also
    // visible in the debug log) the base is a strict prefix of a *longer*
    // string, so trailing-slash-stripping the loc doesn't change whether it
    // starts with the base, and the dedup still fires correctly. Only for
    // this one route — the crawled duplicate of the home page, whose loc
    // *equals* `app.baseURL` and nothing else — does stripping its own
    // trailing slash make it one character *shorter* than the base, so
    // `path.startsWith(base)` now fails on that trailing slash alone, the
    // strip never fires, and the base gets prepended a second time:
    // `https://ripwords.github.io/insta360-luna-ultra-desktop/insta360-luna-ultra-desktop`.
    //
    // This is a real, reproducible interaction bug between two upstream
    // packages (`nitropack`'s crawler and `site-config-stack`'s URL
    // resolver), not something reachable from this app's own config —
    // there's no supported Nitro/Nuxt option to make the crawler recognise
    // that a discovered link already equals the site's own baseURL. The
    // closest available "fix the cause, not the symptom" options were
    // evaluated and rejected:
    //   - Disabling the whole "nuxt:prerender" source (`excludeAppSources`)
    //     removes the phantom, but also removes "/", "/demo", and all
    //     "/demo/*" entries, per the testing above — a worse regression than
    //     the defect being fixed.
    //   - Patching `node_modules` isn't durable across installs and isn't
    //     available as a first-party config surface.
    // So the fix is a single exact-match `sitemap.exclude` entry for this
    // one known-bad, fully-determined path (computed from the same
    // `baseURL` constant this file already defines, not a hardcoded
    // duplicate literal, so it can't silently drift from it) — the smallest
    // change that removes exactly the phantom URL and nothing else. Content
    // pages additionally now have their own explicit, crawl-independent
    // sitemap source (see `content.config.ts`'s `asSitemapCollection`),
    // which the brief's "give the module an explicit URL source" option
    // anticipates — it doesn't fix this specific defect (the phantom
    // survives even with it in place, since "nuxt:prerender" still runs),
    // but it does mean the four /docs/* routes no longer *depend solely* on
    // the crawler that produced this bug.
  },

  // This config is inert in practice — kept only because the task brief
  // calls for it and because `defineOgImageComponent()` (the composable that
  // would actually consume it) still typechecks and auto-imports correctly,
  // so nothing here signals that it doesn't work.
  //
  // `ogImage.defaults` only supplies fallback props for a page that calls
  // `defineOgImage()`/`defineOgImageComponent()`; it never injects a tag by
  // itself. Actually calling `defineOgImageComponent("NuxtSeo", {...})` (as
  // this config anticipates) fails the entire `nuxt generate` outright with
  // "[400] Invalid island request hash" while satori tries to render the
  // `NuxtSeo` template through Nuxt's component-islands machinery — this is
  // a real version incompatibility, not a config mistake: Nuxt 4.5.0 added a
  // `source` field to the tuple `getIslandHash()` hashes
  // (`@nuxt/nitro-server/dist/runtime/nuxt/src/app/island-hash.mjs`, tagged
  // "@since 4.5.0"), but `nuxt-og-image@5.1.13` declares a peer dependency
  // on `nuxt@^4.2.2` and pre-dates that change, so the island URL it builds
  // (and hashes) for the OG-image render request no longer matches what
  // Nuxt's own island endpoint recomputes and expects on arrival — every
  // request 400s.
  //
  // There's no reasonable in-repo fix for a hash-algorithm mismatch between
  // an installed app framework version and a SEO module that hasn't caught
  // up to it yet; downgrading Nuxt itself is out of scope for a docs-site
  // SEO task. So every page instead sets a plain static `ogImage` via
  // `useSeoMeta()` (see `app/pages/index.vue` and
  // `app/pages/docs/[...slug].vue`) pointing at `public/og.png` — a real
  // file that ships in the output, satisfying "every page has a working
  // og:image" without going through the broken dynamic renderer at all.
  ogImage: {
    defaults: {
      component: "NuxtSeo",
      props: {
        title: "Luna Ultra Desktop",
        description: "A desktop companion for the Insta360 Luna Ultra.",
      },
    },
  },

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
    baseURL,
  },

  // Nitro is supposed to auto-detect GitHub Actions (via the `GITHUB_ACTIONS`
  // env var) and apply the `github_pages` preset itself, which is what
  // actually writes `.nojekyll` into the output — without it, GitHub Pages
  // silently drops any `_`-prefixed directory, which breaks Nuxt's `_nuxt/`
  // asset folder and yields a completely unstyled site. That auto-detection
  // did not fire in this repo's build (confirmed: `.nojekyll` was absent
  // from `.output/public` after a plain `nuxt generate`), so the preset is
  // pinned explicitly instead of relying on it.
  nitro: {
    preset: "github_pages",
  },

  // Origin only — no path. `@nuxtjs/seo` combines `site.url` with
  // `app.baseURL` itself; including the path in both produces a
  // doubled-up prefix (`https://ripwords.github.io/insta360-luna-ultra-desktop/insta360-luna-ultra-desktop`)
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
  // project site can only ever serve `/insta360-luna-ultra-desktop/robots.txt`,
  // which crawlers ignore — only `https://ripwords.github.io/robots.txt`
  // (repo root) is authoritative, and this site doesn't own that path.
  // robots.txt is out of scope for this site.
  robots: {
    robotsTxt: false,
  },

  compatibilityDate: "2026-06-30",
});
