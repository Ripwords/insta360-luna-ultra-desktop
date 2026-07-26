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
    // That crawl-only path is what produces the doubled-baseURL phantom
    // sitemap entry (see nuxt.config.ts `sitemap.excludeAppSources`) — giving
    // content pages an explicit source lets that crawl-derived source be
    // disabled entirely without losing these routes from the sitemap.
    docs: defineCollection(
      asSitemapCollection({
        type: "page",
        source: "docs/**/*.md",
      }),
    ),
  },
});
