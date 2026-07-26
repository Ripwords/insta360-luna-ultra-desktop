import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../../FEATURES.md");
const target = resolve(here, "../content/docs/4.feature-status.md");

const frontmatter = `---
title: Feature status
description: What is shipped, what is built but gated off, and what is on hold — the feature map, area by area.
---

`;

const rawBody = await readFile(source, "utf8");

// FEATURES.md opens with its own `# Feature map — ...` heading. `UPageHeader`
// on the docs page already renders the frontmatter `title` as the page's H1,
// so keeping this one too gives every reader two H1s. Strip only the single
// leading heading line (and the blank line after it), not any `#` that shows
// up further down as prose or in a code block.
const body_ = rawBody.replace(/^#\s+.*\n+/, "");

// FEATURES.md links relative to its own location on GitHub (e.g. to a spec
// file under docs/superpowers/specs/), a context this site doesn't have: that
// spec markdown isn't part of the `docs` collection, so the relative link
// resolves to a route that doesn't exist. Nitro's prerender crawler follows
// every link it finds and hard-fails the whole `generate` on a 404, so
// rewrite any non-absolute, non-fragment link target to point at the real
// file on GitHub instead of a route on this site.
const REPO_BLOB_ROOT = "https://github.com/Ripwords/insta360-luna-ultra-desktop/blob/master/docs/";
const body = body_.replace(/\]\(([^)]+)\)/g, (match, target_) => {
  if (/^([a-z]+:)?\/\//i.test(target_) || target_.startsWith("#")) return match;
  return `](${REPO_BLOB_ROOT}${target_})`;
});

await mkdir(dirname(target), { recursive: true });
await writeFile(target, frontmatter + body, "utf8");
console.log(`synced ${source} -> ${target}`);
