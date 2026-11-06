import { describe, expect, it } from "vitest";
import { errorMessage } from "~/utils/errorMessage";

describe("errorMessage", () => {
  it("uses an Error's message", () => {
    expect(errorMessage(new Error("timed out"), "fallback")).toBe("timed out");
  });

  // Tauri's invoke() rejects with the Rust command's Err(String) as a bare string.
  it("uses a rejected string as the message", () => {
    expect(
      errorMessage(
        "cannot reach camera at 192.168.42.1:6666: No route to host (os error 65)",
        "fallback",
      ),
    ).toBe("cannot reach camera at 192.168.42.1:6666: No route to host (os error 65)");
  });

  it("falls back for empty or non-message values", () => {
    expect(errorMessage("", "fallback")).toBe("fallback");
    expect(errorMessage(new Error(""), "fallback")).toBe("fallback");
    expect(errorMessage(undefined, "fallback")).toBe("fallback");
    expect(errorMessage({ code: 1 }, "fallback")).toBe("fallback");
  });
});
