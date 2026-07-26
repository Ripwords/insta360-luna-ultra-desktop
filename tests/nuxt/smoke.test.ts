import { describe, expect, it } from "vitest";
import { mountComposable } from "./harness";

describe("nuxt test environment", () => {
  it("runs a composable that uses useState", async () => {
    const state = await mountComposable(() => useState<number>("smoke", () => 41));
    expect(state.value).toBe(41);
    state.value = 42;
    expect(state.value).toBe(42);
  });
});
