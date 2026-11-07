import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- a plain .mjs build script, without type declarations
import { OUTPUT, buildObsPage } from "../scripts/build-obs-player.mjs";

describe("OBS player page", () => {
  it("is rebuilt from app/obs/player.ts (run `bun run build:obs`)", async () => {
    expect(readFileSync(OUTPUT, "utf8")).toBe(await buildObsPage());
  });
});
