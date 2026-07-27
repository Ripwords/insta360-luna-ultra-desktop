import type { CameraInfo, LiveViewStats, MediaItem } from "#layer/types/media";
import type { CameraTransport } from "#layer/utils/transport";
import { buildMediaItems, entriesFromPaths } from "#layer/utils/lunaIndex";
import { createCommandChannel } from "./mockCommands";
import { FIXTURE_PATHS, FIXTURE_SIZES, fixtureUrl } from "./fixtures";

export interface MockState {
  /** Camera paths still "on" the camera; delete removes from here. */
  paths: string[];
  connected: boolean;
}

const INFO: CameraInfo = {
  host: "192.168.42.1",
  deviceName: "Luna Ultra (simulated)",
  serial: "DEMO-0000000",
  firmware: "1.0.238",
  ssid: "Luna Ultra.OSC",
};

/** Latency, so the UI's loading states are visible rather than instant. */
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createMockTransport(seed: Partial<MockState> = {}): CameraTransport {
  const state: MockState = {
    paths: seed.paths ?? [...FIXTURE_PATHS],
    connected: seed.connected ?? false,
  };
  const command = createCommandChannel();

  return {
    get available() {
      return true;
    },

    async connect(): Promise<CameraInfo> {
      await delay(600);
      state.connected = true;
      return INFO;
    },

    async disconnect(): Promise<void> {
      state.connected = false;
    },

    async status(): Promise<CameraInfo | null> {
      return state.connected ? INFO : null;
    },

    async listMedia(): Promise<MediaItem[]> {
      await delay(400);
      // Deliberately shallow-faked: produce paths and let the app's real
      // parser build the items, so the demo exercises lunaIndex for real.
      // entriesFromPaths always reports size 0 (it mirrors the firmware's
      // GET_FILE_LIST, which doesn't carry sizes either), so the real sizes
      // recorded alongside the generated fixtures are overlaid here before
      // buildMediaItems runs — otherwise every gallery entry reads "0 B".
      const entries = entriesFromPaths(state.paths, fixtureUrl).map((entry) => ({
        ...entry,
        size: FIXTURE_SIZES[entry.name] ?? entry.size,
      }));
      const items = buildMediaItems(entries);
      items.sort((a, b) => b.takenAt - a.takenAt);
      return items;
    },

    async deleteFiles(cameraPaths: string[]): Promise<void> {
      await delay(300);
      const removing = new Set(cameraPaths);
      state.paths = state.paths.filter((path) => !removing.has(path));
    },

    command,

    async liveViewStart(): Promise<{ url: string; port: number }> {
      // Task 5 points this at the generated Annex-B fixture.
      throw new Error("Live view is not wired up yet.");
    },

    async liveViewStop(): Promise<void> {},

    async liveViewStats(): Promise<LiveViewStats> {
      return { bytes: 0, frames: 0, firstBytesHex: "", seconds: 0 };
    },

    async probeOscPreview(): Promise<string | null> {
      // Null forces the annexb path, which is what the fixture provides.
      return null;
    },

    fetch(url: string, init?: RequestInit): Promise<Response> {
      // Fixtures are ordinary static files; no health reporting is meaningful
      // for a mock, and the interface documents that implementations own it.
      return globalThis.fetch(url, init);
    },

    async probe(): Promise<boolean> {
      return state.connected;
    },

    async onDisconnect(): Promise<() => void> {
      return () => {};
    },
  };
}
