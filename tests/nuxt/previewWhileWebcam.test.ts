import { afterEach, describe, expect, it } from "vitest";
import { mountSuspended } from "@nuxt/test-utils/runtime";
import CameraPage from "~/pages/camera.vue";
import { resetCameraTransport, setCameraTransport } from "~/utils/transport";
import { makeFakeTransport } from "../helpers/fakeTransport";
import { mountComposable } from "./harness";

const PAUSED = "Webcam mode is on, so the preview is paused";

const mounted: { unmount(): void }[] = [];

async function mountPage() {
  const page = await mountSuspended(CameraPage);
  mounted.push(page);
  return page;
}

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("the camera page while webcam mode is on", () => {
  afterEach(() => {
    // A page left mounted would start its preview on the next test's connect.
    for (const page of mounted.splice(0)) page.unmount();
    resetCameraTransport();
    document.body.innerHTML = "";
    clearNuxtState(
      [
        "camera-status",
        "camera-info",
        "camera-want-connection",
        "liveview-active",
        "liveview-starting",
        "liveview-transport",
        "liveview-url",
        "webcam-enabled",
        "webcam-status",
      ],
      { reset: true },
    );
  });

  it("stops the preview while webcam mode is on and resumes it after", async () => {
    const transport = makeFakeTransport();
    setCameraTransport(transport);
    const { camera, live } = await mountComposable(() => ({
      camera: useCamera(),
      live: useLiveView(),
    }));
    await camera.connect();
    const enabled = useState<boolean>("webcam-enabled");

    const page = await mountPage();
    await settle();
    expect(live.active.value).toBe(true);

    enabled.value = true;
    await settle();
    expect(transport.liveViewStop).toHaveBeenCalled();
    expect(live.active.value).toBe(false);
    expect(page.text()).toContain(PAUSED);
    expect(page.text()).not.toContain("Start preview");

    enabled.value = false;
    await settle();
    expect(live.active.value).toBe(true);
  });

  it("does not start the preview when the page opens in webcam mode", async () => {
    const transport = makeFakeTransport();
    setCameraTransport(transport);
    const { camera } = await mountComposable(() => ({ camera: useCamera() }));
    await camera.connect();
    useState<boolean>("webcam-enabled").value = true;

    const page = await mountPage();
    await settle();
    expect(transport.liveViewStart).not.toHaveBeenCalled();
    expect(page.text()).toContain(PAUSED);
  });
});
