import { afterEach, describe, expect, it, vi } from "vitest";
import { mountSuspended } from "@nuxt/test-utils/runtime";
import { defineComponent, h } from "vue";
import { UApp } from "#components";
import AppShell from "~/components/AppShell.vue";
import CameraImage from "~/components/CameraImage.vue";
import MediaPreview from "~/components/MediaPreview.vue";
import VideoThumb from "~/components/VideoThumb.vue";
import WatermarkCanvas from "~/components/WatermarkCanvas.vue";
import WebcamPanel from "~/components/WebcamPanel.vue";
import { setCameraQueueHeld } from "~/utils/cameraQueue";
import { resetCameraTransport, setCameraTransport } from "~/utils/transport";
import { makeFakeTransport } from "../helpers/fakeTransport";
import { makeMediaItem } from "../helpers/media";

const PAUSED = '[aria-label="Paused while webcam mode is on"]';

describe("camera traffic while webcam mode holds the queue", () => {
  afterEach(() => {
    setCameraQueueHeld(false);
    resetCameraTransport();
    document.body.innerHTML = "";
    clearNuxtState(["webcam-enabled", "webcam-status", "webcam-error"], { reset: true });
  });

  it("shows a still paused placeholder on a thumbnail instead of a spinner", async () => {
    setCameraTransport(makeFakeTransport());
    setCameraQueueHeld(true);
    const tile = await mountSuspended(CameraImage, {
      props: { src: "http://127.0.0.1/DCIM/held-thumb.jpg", alt: "held" },
    });

    expect(tile.find(PAUSED).exists()).toBe(true);
    expect(tile.find(".animate-spin").exists()).toBe(false);
  });

  it("shows the paused placeholder on a video thumbnail", async () => {
    setCameraTransport(makeFakeTransport());
    setCameraQueueHeld(true);
    const tile = await mountSuspended(VideoThumb, {
      props: { src: "http://127.0.0.1/DCIM/held.mp4", eager: true },
    });

    expect(tile.find(PAUSED).exists()).toBe(true);
    expect(tile.find(".animate-spin").exists()).toBe(false);
  });

  it("does not fetch the watermark sample until the hold is released", async () => {
    const transport = makeFakeTransport();
    setCameraTransport(transport);
    setCameraQueueHeld(true);
    const canvas = await mountSuspended(WatermarkCanvas, {
      props: { src: "http://127.0.0.1/DCIM/sample.jpg" },
    });

    expect(transport.fetch).not.toHaveBeenCalled();
    expect(canvas.find(PAUSED).exists()).toBe(true);

    setCameraQueueHeld(false);
    await nextTick();
    expect(transport.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not point the preview's video at the camera while held", async () => {
    setCameraTransport(makeFakeTransport());
    setCameraQueueHeld(true);
    await mountSuspended(MediaPreview, {
      props: {
        open: true,
        item: makeMediaItem({ name: "VID_0001.mp4", type: "video", ext: "mp4" }),
        hasPrev: false,
        hasNext: false,
      },
    });

    expect(document.body.querySelector("video")).toBeNull();
    expect(document.body.querySelector(PAUSED)).not.toBeNull();

    setCameraQueueHeld(false);
    await nextTick();
    expect(document.body.querySelector("video")).not.toBeNull();
  });

  it("disables the preview's download buttons when downloads are disabled", async () => {
    setCameraTransport(makeFakeTransport());
    await mountSuspended(MediaPreview, {
      props: {
        open: true,
        item: makeMediaItem(),
        hasPrev: false,
        hasNext: false,
        downloadDisabled: true,
      },
    });

    const downloads = [...document.body.querySelectorAll("button")].filter((b) =>
      b.textContent?.includes("Download"),
    );
    expect(downloads.length).toBeGreaterThan(0);
    for (const button of downloads) expect(button.disabled).toBe(true);
  });
});

describe("WebcamPanel", () => {
  afterEach(() => {
    resetCameraTransport();
    clearNuxtState(["webcam-enabled", "webcam-status", "webcam-error"], { reset: true });
  });

  it("explains the OBS setup inline instead of linking out", async () => {
    setCameraTransport(makeFakeTransport());
    useState<boolean>("webcam-enabled").value = true;
    const panel = await mountSuspended(WebcamPanel);

    expect(panel.find("a").exists()).toBe(false);
    const toggle = panel.findAll("button").find((b) => b.text().includes("Set up OBS"));
    expect(toggle).toBeDefined();
    await toggle!.trigger("click");
    await vi.dynamicImportSettled();

    const text = panel.text();
    expect(text).toContain("Media Source");
    expect(text).toContain("Local File");
    expect(text).toContain("Start Virtual Camera");
  });
});

describe("Camera nav item", () => {
  afterEach(() => {
    resetCameraTransport();
    clearNuxtState(["webcam-enabled"], { reset: true });
  });

  it("carries a labelled webcam indicator only while webcam mode is on", async () => {
    setCameraTransport(makeFakeTransport());
    // UApp provides the tooltip context the sidebar's tooltips need.
    const shell = await mountSuspended(
      defineComponent({ render: () => h(UApp, () => h(AppShell)) }),
    );
    const indicator = () =>
      shell.find('nav a[href="/camera"] [aria-label="Webcam mode on"]').exists();
    expect(indicator()).toBe(false);

    useState<boolean>("webcam-enabled").value = true;
    await nextTick();
    expect(indicator()).toBe(true);
  });
});
