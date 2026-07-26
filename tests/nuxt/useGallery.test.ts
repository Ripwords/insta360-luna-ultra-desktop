import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetCameraTransport, setCameraTransport } from "~/utils/transport";
import { makeFakeTransport } from "../helpers/fakeTransport";
import { makeMediaItem } from "../helpers/media";
import { mountComposable } from "./harness";

describe("useGallery", () => {
  beforeEach(() => {
    localStorage.clear();
    clearNuxtState(["camera-host"], { reset: true });
  });

  afterEach(() => {
    resetCameraTransport();
    clearNuxtState([
      "camera-status",
      "camera-info",
      "camera-library",
      "camera-error",
      "camera-library-loading",
      "camera-want-connection",
      "camera-retry-attempt",
      "gallery-filter",
      "gallery-storage",
      "gallery-thumb-size",
      "gallery-selected",
      "gallery-anchor",
    ]);
  });

  it("deletes through the transport using camera paths", async () => {
    const transport = makeFakeTransport();
    setCameraTransport(transport);

    const { camera, gallery } = await mountComposable(() => ({
      camera: useCamera(),
      gallery: useGallery(),
    }));

    camera.library.value = [
      makeMediaItem({ id: "a", name: "IMG_0001.jpg" }),
      makeMediaItem({ id: "b", name: "IMG_0002.jpg" }),
    ];
    gallery.selected.value = new Set(["a"]);

    await gallery.deleteSelected();

    expect(transport.deleteFiles).toHaveBeenCalledWith(["/DCIM/Camera01/IMG_0001.jpg"]);
    expect(camera.library.value).toHaveLength(1);
  });

  it("leaves the library intact when the camera rejects the delete", async () => {
    setCameraTransport(
      makeFakeTransport({
        deleteFiles: vi.fn(async () => {
          throw new Error("rejected");
        }),
      }),
    );

    const { camera, gallery } = await mountComposable(() => ({
      camera: useCamera(),
      gallery: useGallery(),
    }));

    camera.library.value = [makeMediaItem({ id: "a", name: "IMG_0001.jpg" })];
    gallery.selected.value = new Set(["a"]);

    await gallery.deleteSelected();

    expect(camera.library.value).toHaveLength(1);
  });
});
