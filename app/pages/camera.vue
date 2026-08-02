<script setup lang="ts">
import { optionLabel } from "~/utils/cameraLabels";
import { FEATURES } from "~/utils/features";

const { isConnected } = useCamera();
const { device, settings, loading, error, load } = useCameraSettings();
const { active, starting, error: liveError, diagnostics, start, stop } = useLiveView();
const { recording, elapsedLabel } = useCameraCapture();
// Scrolling over the picture is the desktop way to zoom; the dial is a readout
// you can also drag. Both drive the same gesture state.
const { onWheel } = useCameraZoom();

useHead({ title: "Camera" });

/** The deep settings live in a slide-over, so the viewfinder never scrolls. */
const settingsOpen = ref(false);

/**
 * Opening the page should feel like picking up a camera: the preview starts on
 * its own as soon as we are connected, and stops when the connection drops.
 */
watch(
  isConnected,
  (connected) => {
    if (connected) void start();
    else void stop();
  },
  { immediate: true },
);

/**
 * The preview holds the camera's single HTTP connection. Release it *before*
 * navigating away and wait for it to close — otherwise the next page (e.g. the
 * gallery, which reads media over that same connection) races the tear-down,
 * its requests fail, and the health detector force-disconnects the camera.
 */
onBeforeRouteLeave(async () => {
  await stop();
});

const battery = computed(() => {
  const status = device.value.battery_status as Record<string, unknown> | undefined;
  return typeof status?.battery_level === "number" ? status.battery_level : null;
});

const batteryClass = computed(() => {
  if (battery.value === null) return "";
  if (battery.value <= 20) return "text-red-400";
  if (battery.value <= 40) return "text-amber-300";
  return "";
});

const storage = computed(() => {
  const state = device.value.storage_state as Record<string, unknown> | undefined;
  if (typeof state?.free_space !== "number") return null;
  return state.free_space / 1e9;
});

/** The camera reports remaining recording time in seconds. */
const remaining = computed(() => {
  const seconds = settings.value.remaining_time;
  if (typeof seconds !== "number" || seconds <= 0) return null;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h${minutes}m` : `${minutes}m`;
});

/**
 * RES_3840_2160P30 reads as "3840×2160 · 30p" — the way a camera prints it,
 * rather than the enum name with its underscores swapped for spaces.
 */
const resolution = computed(() => {
  const raw = settings.value.record_resolution;
  if (!raw) return null;
  const match = /^RES_(\d+)_(\d+)P(\d+)$/.exec(String(raw));
  if (!match) return String(raw).replace("RES_", "").replace(/_/g, " ");
  return `${match[1]}×${match[2]} · ${match[3]}p`;
});

/** The look that is being baked into the recording, worth knowing at a glance. */
const activeFilter = computed(() => {
  const filter = settings.value.gamma_mode;
  if (!filter || String(filter) === "FILTER_NONE") return null;
  return optionLabel(String(filter));
});

const colorMode = computed(() =>
  settings.value.color_mode ? optionLabel(String(settings.value.color_mode)) : null,
);

/** One quiet line at the top of the stage, so errors never reflow the layout. */
const topError = computed(() => liveError.value ?? error.value ?? null);
</script>

<template>
  <UDashboardPanel id="camera">
    <template #header>
      <UDashboardNavbar title="Camera">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <UButton
            icon="i-lucide-refresh-cw"
            color="neutral"
            variant="ghost"
            :loading
            :disabled="!isConnected"
            aria-label="Reload settings"
            @click="() => load()"
          />
          <UButton
            v-if="FEATURES.allSettings"
            icon="i-lucide-sliders-horizontal"
            color="neutral"
            variant="ghost"
            :disabled="!isConnected"
            aria-label="Camera settings"
            @click="settingsOpen = true"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div
        v-if="!isConnected"
        class="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center"
      >
        <UIcon name="i-lucide-video-off" class="size-8 text-dimmed" />
        <div class="space-y-1">
          <p class="font-medium text-highlighted">No camera connected</p>
          <p class="max-w-sm text-sm text-muted">
            Join the Luna Ultra's Wi-Fi network and connect, and the viewfinder starts here.
          </p>
        </div>
        <UButton label="Connect" icon="i-lucide-plug" to="/" />
      </div>

      <div v-else class="flex min-h-0 flex-1 flex-col gap-3">
        <!-- Viewfinder: the hero. Everything else floats over it. -->
        <div class="relative min-h-0 flex-1 overflow-hidden rounded-2xl bg-black" @wheel="onWheel">
          <LiveView class="absolute inset-0" />

          <!-- Starting / stopped state, centred over the black stage -->
          <div
            v-if="!active"
            class="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white/60"
          >
            <template v-if="starting">
              <UIcon name="i-lucide-loader-circle" class="size-6 animate-spin" />
              <span class="text-sm">Starting preview…</span>
            </template>
            <UButton
              v-else
              icon="i-lucide-play"
              color="neutral"
              variant="subtle"
              label="Start preview"
              @click="start"
            />
          </div>

          <!--
            Frame marks. A viewfinder shows you the bounds of what it is
            recording, and the brackets are how every camera says it. They also
            give the black stage a job when the preview has not started.
          -->
          <div class="pointer-events-none absolute inset-4 z-10">
            <span class="absolute left-0 top-0 size-5 border-l border-t border-white/25" />
            <span class="absolute right-0 top-0 size-5 border-r border-t border-white/25" />
            <span class="absolute bottom-0 left-0 size-5 border-b border-l border-white/25" />
            <span class="absolute bottom-0 right-0 size-5 border-b border-r border-white/25" />
          </div>

          <!--
            One scrim carries every readout, instead of each getting its own
            pill. Camera markings are engraved onto the finder, not stuck on it.
          -->
          <div
            class="pointer-events-none absolute inset-x-0 top-0 z-10 bg-gradient-to-b from-black/70 via-black/30 to-transparent pb-8"
          >
            <div
              class="flex items-start justify-between gap-4 p-4 pr-14 font-mono text-[11px] text-white/70"
            >
              <div class="flex items-center gap-3">
                <!--
                  Red appears exactly once in this interface, and it means
                  recording. Anything else wearing it would dilute the one
                  signal you must never misread.
                -->
                <span v-if="recording" class="flex items-center gap-1.5 text-white">
                  <span class="size-2 rounded-full bg-red-500 motion-safe:animate-pulse" />
                  <span class="tabular-nums tracking-wider">{{ elapsedLabel }}</span>
                </span>
                <span v-if="remaining" class="tracking-wider">{{ remaining }} left</span>
                <span v-if="storage" class="tracking-wider">{{ storage.toFixed(1) }} GB</span>
              </div>

              <!--
                The readouts keep their single line; the histogram hangs below
                them on the same right rail, clear of the zoom dial's column.
              -->
              <div class="flex flex-col items-end gap-2 text-right">
                <div class="flex items-center gap-3">
                  <span v-if="activeFilter" class="tracking-wider text-white">{{
                    activeFilter
                  }}</span>
                  <span v-if="colorMode" class="tracking-wider">{{ colorMode }}</span>
                  <span v-if="resolution" class="tracking-wider">{{ resolution }}</span>
                  <span
                    v-if="battery !== null"
                    class="flex items-center gap-1 tabular-nums tracking-wider"
                    :class="batteryClass"
                  >
                    <UIcon name="i-lucide-battery" class="size-3.5" />
                    {{ battery }}%
                  </span>
                </div>

                <CameraHistogram />
              </div>
            </div>
          </div>

          <!--
            The zoom dial hugs the right edge, clear of the readout rail above
            and the pro bar below, so a drag never lands on another control.
          -->
          <div class="absolute inset-y-20 right-2 z-20 flex items-center">
            <CameraZoomDial />
          </div>

          <!-- Errors sit below the readout rail, so neither ever moves -->
          <div v-if="topError" class="absolute inset-x-0 top-14 z-20 flex justify-center px-4">
            <span
              class="flex items-center gap-1.5 rounded-lg bg-warning/90 px-3 py-1.5 text-xs text-white shadow-lg backdrop-blur-md"
            >
              <UIcon name="i-lucide-triangle-alert" class="size-3.5 shrink-0" />
              {{ topError }}
            </span>
          </div>

          <!-- Quick exposure bar + gear, along the bottom of the viewfinder -->
          <div
            class="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/70 via-black/40 to-transparent p-2 pr-12 pt-10"
          >
            <CameraProBar @open-settings="settingsOpen = true" />
          </div>
        </div>

        <!-- Mode strip + shutter -->
        <CameraCaptureBar />
      </div>

      <!-- Portals to the document body, so it lives here without disturbing the panel slots -->
      <USlideover
        v-model:open="settingsOpen"
        title="Camera settings"
        description="Everything the camera exposes."
      >
        <template #body>
          <CameraSettings />

          <details v-if="diagnostics.length > 0" class="mt-8 text-sm">
            <summary class="cursor-pointer text-muted">Live view diagnostics</summary>
            <pre class="mt-2 overflow-x-auto rounded bg-elevated p-3 text-xs">{{
              diagnostics.join("\n")
            }}</pre>
          </details>
        </template>
      </USlideover>
    </template>
  </UDashboardPanel>
</template>
