import { afterEach, describe, expect, it } from "vitest";
import { lunaClient } from "~/utils/lunaClient";
import { resetCameraTransport, setCameraTransport, useCameraTransport } from "~/utils/transport";
import { makeFakeTransport } from "./helpers/fakeTransport";

describe("cameraTransport registry", () => {
  afterEach(() => {
    resetCameraTransport();
  });

  it("defaults to the real luna client", () => {
    expect(useCameraTransport()).toBe(lunaClient);
  });

  it("returns the transport that was set", () => {
    const fake = makeFakeTransport();
    setCameraTransport(fake);
    expect(useCameraTransport()).toBe(fake);
  });

  it("restores the real client on reset", () => {
    setCameraTransport(makeFakeTransport());
    resetCameraTransport();
    expect(useCameraTransport()).toBe(lunaClient);
  });

  it("routes calls to the active transport", async () => {
    const fake = makeFakeTransport();
    setCameraTransport(fake);
    await useCameraTransport().connect("10.0.0.1");
    expect(fake.connect).toHaveBeenCalledWith("10.0.0.1");
  });
});
