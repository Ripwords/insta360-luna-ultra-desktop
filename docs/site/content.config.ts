import { defineCollection, defineContentConfig } from "@nuxt/content";
import { asSitemapCollection } from "@nuxtjs/sitemap/content";

export default defineContentConfig({
  collections: {
    // `asSitemapCollection` adds a `sitemap` schema field so `@nuxtjs/sitemap`'s
    // `content:file:afterParse` hook registers each page as an explicit sitemap
    // source (`loc: content.path`). Without it, these pages have no entry in
    // Nuxt's static page-route array (the `/docs/[...slug]` catch-all's `:slug`
    // segment gets filtered out of that source) and are only ever discovered
    // by the Nitro prerender crawler re-visiting links found in rendered HTML.
    // That crawl-only path is also what produces the doubled-baseURL phantom
    // sitemap entry (see the long `sitemap.exclude` comment in nuxt.config.ts)
    // — but disabling the crawl-derived "nuxt:prerender" source outright
    // (`sitemap.excludeAppSources`) was evaluated there and rejected, since it
    // also drops "/", "/demo" and every "/demo/*" route, which have no other
    // source. Giving content pages their own explicit source here just means
    // the four /docs/* routes no longer *depend solely* on that crawler —
    // the phantom entry itself is still fixed by the exact-match
    // `sitemap.exclude` entry in nuxt.config.ts, not by anything here.
    docs: defineCollection(
      asSitemapCollection({
        type: "page",
        source: "docs/**/*.md",
      }),
    ),
  },
});
