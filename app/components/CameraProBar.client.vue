<script setup lang="ts">
import {
  isoLabel,
  isoSteps,
  optionLabel,
  shutterLabel,
  shutterNameForSeconds,
  shutterSteps,
  resolutionParts,
  composeResolution,
} from "~/utils/cameraLabels";
import {
  colorModesFor,
  filterHasIntensity,
  supportsColorMode,
  supportsFilter,
  supportsPanoAspect,
  sizesFor,
  aspectsFor,
  fpsFor,
} from "~/utils/cameraCapabilities";
import { enumNames } from "~/utils/lunaProto";
import { FEATURES } from "~/utils/features";
import type { WheelStep } from "~/utils/cameraLabels";
import type { ProtoObject } from "~/utils/lunaProto";

/**
 * The Pro row from the phone app: a strip of chips showing each setting's
 * current value, one of which expands into a wheel. Only one wheel is open at
 * a time, which is what keeps the row readable on a narrow window.
 */
const {
  settings,
  saving,
  status,
  update,
  setExposure,
  setWhiteBalanceKelvin,
  setColorMode,
  setFilter,
  setFilterIntensity,
} = useCameraSettings();
const { modeId } = useCameraCapture();

/** The gear hands control back to the page, which owns the settings drawer. */
const emit = defineEmits<{ "open-settings": [] }>();

type ChipId =
  | "iso"
  | "shutter"
  | "ev"
  | "colour"
  | "filter"
  | "strength"
  | "aspect"
  | "res"
  | "fps"
  | "ratio"
  | "wb"
  | "sharpness";

const open = ref<ChipId | null>(null);
const toggle = (id: ChipId) => (open.value = open.value === id ? null : id);

// Exposure lives in video_exposure now: iso (0 = Auto) and shutter_speed as raw
// seconds (0 = Auto). Map the seconds back to a wheel step for display.
const videoExp = computed(() => (settings.value.video_exposure as ProtoObject | undefined) ?? {});
const manualIso = computed(() => Number(videoExp.value.iso ?? 0));
const shutterSecs = computed(() => Number(videoExp.value.shutter_speed ?? 0));
const manualShutter = computed(() => shutterNameForSeconds(shutterSecs.value));
const isoAuto = computed(() => manualIso.value === 0);
const shutterAuto = computed(() => shutterSecs.value === 0);

/** The camera's EV compensation is in 1/3 stops (0, 0.3, 0.7, 1.0, …). We send
 * exposure_bias as a signed count of thirds and label it as the EV it shows. */
const evLabel = (thirds: number): string => {
  if (!thirds) return "0";
  const ev = (Math.round((thirds / 3) * 10) / 10).toFixed(1);
  return thirds > 0 ? `+${ev}` : ev;
};
const evSteps = Array.from({ length: 25 }, (_, i) => {
  const thirds = i - 12; // ±4.0 EV in 1/3 stops, matching the camera's dial
  return { value: String(thirds), label: evLabel(thirds) };
});

/** The camera's white balance dial: Auto plus 2000–10000K in 200K steps. */
const wbSteps = [
  { value: "0", label: "Auto" },
  ...Array.from({ length: 41 }, (_, i) => {
    const k = 2000 + i * 200;
    return { value: String(k), label: `${k / 1000}K` };
  }),
];
// The camera's white_balance_value read-back is unreliable (it reports 10000 no
// matter what, though the write itself works), so drive the wheel off the last
// value the user picked, falling back to the read value only before any choice.
const wbChoice = ref<number | null>(null);
const wbKelvin = computed(() => wbChoice.value ?? Number(settings.value.white_balance_value ?? 0));
const wbIsAuto = computed(() => wbKelvin.value === 0);
const selectWb = (kelvin: number) => {
  wbChoice.value = kelvin;
  void setWhiteBalanceKelvin(kelvin);
};

const sharpnessSteps = [
  { value: "0", label: "Off" },
  { value: "1", label: "Low" },
  { value: "2", label: "Medium" },
  { value: "3", label: "High" },
  { value: "4", label: "Max" },
];

/**
 * Colour mode's choices depend on the capture mode — PureVideo has no i-Log —
 * so the wheel is built from the capability table rather than the whole enum.
 */
const colourSteps = computed(() =>
  colorModesFor(modeId.value).map((value) => ({ value, label: optionLabel(value) })),
);

/**
 * The Filter picker, which the camera keeps on `gamma_mode`. Presented in the
 * camera's own order — the three Leica profiles, then the six cinematic looks —
 * rather than by enum number, which interleaves them (Leica Chrome is 36, in
 * amongst the film filters).
 */
const FILTER_ORDER = [
  "FILTER_NONE",
  "FILTER_LEICA_NATURAL",
  "FILTER_LEICA_VIVID",
  "FILTER_LEICA_CHROME",
  "FILTER_POS_FILM",
  "FILTER_NEG_FILM",
  "FILTER_CC_FILM",
  "FILTER_NC_FILM",
  "FILTER_FRESH",
  "FILTER_CINEMATIC",
];

const filterSteps = computed(() => {
  const known = new Set(enumNames("insta360.messages.GammaMode"));
  return FILTER_ORDER.filter((value) => known.has(value)).map((value) => ({
    value,
    label: optionLabel(value),
  }));
});

/**
 * The current resolution taken apart, so the three pickers each show their own
 * axis. Falls back to the mode's first offering before anything has been read.
 */
const currentRes = computed(() => {
  const parts = settings.value.record_resolution
    ? resolutionParts(String(settings.value.record_resolution))
    : null;
  if (parts) return parts;
  const size = sizesFor(modeId.value)[0];
  if (!size) return null;
  const aspect = aspectsFor(modeId.value, size)[0]!;
  return { size, aspect, fps: fpsFor(modeId.value, size, aspect)[0]! };
});

const sizeSteps = computed(() =>
  sizesFor(modeId.value).map((value) => ({ value, label: value })),
);
const aspectRatioSteps = computed(() =>
  currentRes.value
    ? aspectsFor(modeId.value, currentRes.value.size).map((value) => ({ value, label: value }))
    : [],
);
const fpsSteps = computed(() =>
  currentRes.value
    ? fpsFor(modeId.value, currentRes.value.size, currentRes.value.aspect).map((value) => ({
        value: String(value),
        label: `${value}`,
      }))
    : [],
);

/**
 * Changing one axis has to land on a combination that exists: 8K has no 120fps,
 * so arriving from 4K120 keeps the framerate only if 8K has it, and otherwise
 * takes that size's fastest. Same for aspect.
 */
function chooseResolution(next: Partial<{ size: string; aspect: string; fps: number }>) {
  const from = currentRes.value;
  if (!from) return;
  const size = next.size ?? from.size;
  const aspects = aspectsFor(modeId.value, size);
  const aspect = aspects.includes(next.aspect ?? from.aspect)
    ? (next.aspect ?? from.aspect)
    : aspects[0]!;
  const rates = fpsFor(modeId.value, size, aspect);
  const fps = rates.includes(next.fps ?? from.fps) ? (next.fps ?? from.fps) : rates[0]!;

  const name = composeResolution(size, aspect, fps);
  if (name) void update("RECORD_RESOLUTION", "record_resolution", name);
}

const aspectSteps = computed(() =>
  enumNames("insta360.messages.PanoAspect").map((value) => ({
    value,
    label: optionLabel(value),
  })),
);

const strengthSteps = computed(() =>
  enumNames("insta360.messages.FilterIntensity").map((value) => ({
    value,
    label: optionLabel(value),
  })),
);

const currentFilter = computed(() =>
  settings.value.gamma_mode === undefined ? undefined : String(settings.value.gamma_mode),
);

const recordResolution = computed(() =>
  settings.value.record_resolution === undefined
    ? undefined
    : String(settings.value.record_resolution),
);

const filtersAvailable = computed(() =>
  supportsFilter({
    resolution: recordResolution.value,
    colorMode: settings.value.color_mode ? String(settings.value.color_mode) : undefined,
  }),
);
const strengthAvailable = computed(
  () => filtersAvailable.value && filterHasIntensity(currentFilter.value),
);

const chips = computed(() => [
  {
    id: "iso" as const,
    group: "exposure",
    label: "ISO",
    value: isoAuto.value ? "Auto" : isoLabel(manualIso.value),
  },
  {
    id: "shutter" as const,
    group: "exposure",
    label: "SHUTTER",
    value: shutterAuto.value ? "Auto" : shutterLabel(manualShutter.value),
  },
  {
    id: "ev" as const,
    group: "exposure",
    label: "EV",
    value: evLabel(Number(settings.value.exposure_bias ?? 0)),
  },
  {
    id: "colour" as const,
    group: "look",
    label: "COLOR",
    value: settings.value.color_mode ? optionLabel(String(settings.value.color_mode)) : "—",
  },
  {
    id: "filter" as const,
    group: "look",
    label: "FILTER",
    value: optionLabel(currentFilter.value ?? "FILTER_NONE"),
  },
  {
    id: "strength" as const,
    group: "look",
    label: "STRENGTH",
    value: settings.value.filter_intensity
      ? optionLabel(String(settings.value.filter_intensity))
      : "—",
  },
  {
    id: "aspect" as const,
    group: "look",
    label: "ASPECT",
    value: settings.value.pano_aspect ? optionLabel(String(settings.value.pano_aspect)) : "—",
  },
  {
    // Three axes rather than one list of every combination: 37 entries in a
    // strip is a scroll-hunt, and you end up passing 8K to reach 1080p60.
    id: "res" as const,
    group: "format",
    label: "RES",
    value: currentRes.value?.size ?? "—",
  },
  {
    id: "fps" as const,
    group: "format",
    label: "FPS",
    value: currentRes.value ? String(currentRes.value.fps) : "—",
  },
  {
    id: "ratio" as const,
    group: "format",
    label: "RATIO",
    value: currentRes.value?.aspect ?? "—",
  },
  {
    id: "wb" as const,
    group: "image",
    label: "WB",
    value: wbIsAuto.value ? "Auto" : `${wbKelvin.value / 1000}K`,
  },
  {
    id: "sharpness" as const,
    group: "image",
    label: "SHARP",
    value: sharpnessSteps[Number(settings.value.sharpness ?? 0)]?.label ?? "—",
  },
].filter((chip) => {
  if (chip.id === "colour") return FEATURES.colorMode && supportsColorMode(modeId.value);
  if (chip.id === "filter") return filtersAvailable.value;
  if (chip.id === "strength") return strengthAvailable.value;
  if (chip.id === "aspect") return supportsPanoAspect(modeId.value);
  // No measured resolutions for this mode means no picker, rather than one
  // offering numbers the camera may not take
  if (chip.id === "res") return sizeSteps.value.length > 0;
  if (chip.id === "fps") return fpsSteps.value.length > 1;
  // Only worth a chip where the size actually has more than one aspect
  if (chip.id === "ratio") return aspectRatioSteps.value.length > 1;
  return true;
}));

/** What each chip's list holds, and where the current value sits in it. */
const PICKERS: Record<ChipId, { steps: () => WheelStep[]; value: () => string | undefined }> = {
  iso: { steps: () => isoSteps(), value: () => String(manualIso.value) },
  shutter: { steps: () => shutterSteps(), value: () => manualShutter.value },
  ev: { steps: () => evSteps, value: () => String(settings.value.exposure_bias ?? 0) },
  colour: {
    steps: () => colourSteps.value,
    value: () => (settings.value.color_mode ? String(settings.value.color_mode) : undefined),
  },
  filter: { steps: () => filterSteps.value, value: () => currentFilter.value ?? "FILTER_NONE" },
  strength: {
    steps: () => strengthSteps.value,
    value: () =>
      settings.value.filter_intensity ? String(settings.value.filter_intensity) : undefined,
  },
  aspect: {
    steps: () => aspectSteps.value,
    value: () => (settings.value.pano_aspect ? String(settings.value.pano_aspect) : undefined),
  },
  res: { steps: () => sizeSteps.value, value: () => currentRes.value?.size },
  fps: {
    steps: () => fpsSteps.value,
    value: () => (currentRes.value ? String(currentRes.value.fps) : undefined),
  },
  ratio: { steps: () => aspectRatioSteps.value, value: () => currentRes.value?.aspect },
  wb: { steps: () => wbSteps, value: () => String(wbKelvin.value) },
  sharpness: { steps: () => sharpnessSteps, value: () => String(settings.value.sharpness ?? 0) },
};

/** Apply a choice, then close — the decision is made, the list is in the way. */
function choose(id: ChipId, value: string) {
  open.value = null;
  switch (id) {
    case "iso": return void setExposure({ iso: Number(value) });
    case "shutter": return void setExposure({ shutter_speed: value });
    case "ev": return void update("EXPOSURE_BIAS", "exposure_bias", Number(value));
    case "colour": return void setColorMode(value);
    case "filter": return void setFilter(value);
    case "strength": return void setFilterIntensity(value);
    case "aspect": return void update("PANO_ASPECT", "pano_aspect", value);
    case "res": return chooseResolution({ size: value });
    case "fps": return chooseResolution({ fps: Number(value) });
    case "ratio": return chooseResolution({ aspect: value });
    case "wb": return selectWb(Number(value));
    case "sharpness": return void update("SHARPNESS", "sharpness", Number(value));
  }
}

const FIELD_OF: Record<ChipId, string> = {
  // Manual ISO/shutter now write video_exposure/still_exposure, so the verdict
  // (applied/assumed) that tells us whether manual stuck lives on that field.
  iso: "video_exposure",
  shutter: "video_exposure",
  ev: "exposure_bias",
  colour: "color_mode",
  filter: "gamma_mode",
  strength: "filter_intensity",
  aspect: "pano_aspect",
  res: "record_resolution",
  fps: "record_resolution",
  ratio: "record_resolution",
  wb: "white_balance_value",
  sharpness: "sharpness",
};

const VERDICTS = {
  applied: { icon: "i-lucide-check", color: "text-success" },
  differs: { icon: "i-lucide-arrow-left-right", color: "text-warning" },
  assumed: { icon: "i-lucide-circle-help", color: "text-muted" },
  rejected: { icon: "i-lucide-x", color: "text-error" },
} as const;

const verdict = (id: ChipId) => {
  const entry = status.value[FIELD_OF[id]];
  return entry ? VERDICTS[entry.outcome] : null;
};

const busy = (id: ChipId) => saving.value === FIELD_OF[id];
</script>

<template>
  <div class="flex flex-col gap-2">
    <p
      v-if="(open === 'iso' && isoAuto) || (open === 'shutter' && shutterAuto)"
      class="rounded-lg bg-black/60 px-2 py-1 text-center text-xs text-white/70 backdrop-blur-md"
    >
      Pick a value to take this off Auto; leave both on Auto for full auto exposure.
    </p>

    <div class="flex items-stretch gap-0.5 rounded-xl bg-black/50 p-1 backdrop-blur-md">
      <template v-for="(chip, index) in chips" :key="chip.id">
        <!--
          A hairline wherever the concern changes: format, exposure, the look
          being baked in, then image adjustments.
        -->
        <span
          v-if="index > 0 && chip.group !== chips[index - 1]!.group"
          class="my-1.5 w-px shrink-0 bg-white/15"
          aria-hidden="true"
        />
        <div class="relative flex min-w-14 flex-1">
          <button
            type="button"
            class="flex w-full flex-col items-center gap-0.5 rounded-lg px-2 py-1.5 transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white"
            :class="open === chip.id ? 'bg-white/20' : 'hover:bg-white/10'"
            :aria-expanded="open === chip.id"
            @click="toggle(chip.id)"
          >
            <span
              class="flex items-center gap-1 text-[10px] font-medium tracking-wider text-white/50"
            >
              {{ chip.label }}
              <UIcon
                v-if="verdict(chip.id)"
                :name="verdict(chip.id)!.icon"
                :class="verdict(chip.id)!.color"
                class="size-3"
              />
            </span>
            <span class="max-w-full truncate text-sm font-medium text-white">{{ chip.value }}</span>
          </button>

          <CameraPicker
            v-if="open === chip.id"
            :steps="PICKERS[chip.id].steps()"
            :model-value="PICKERS[chip.id].value()"
            :busy="busy(chip.id)"
            @select="(value) => choose(chip.id, value)"
            @dismiss="open = null"
          />
        </div>
      </template>

      <span v-if="FEATURES.allSettings" class="my-1.5 w-px shrink-0 bg-white/15" aria-hidden="true" />

      <button
        v-if="FEATURES.allSettings"
        type="button"
        class="flex min-w-14 flex-col items-center justify-center gap-0.5 rounded-lg px-2 py-1.5 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
        aria-label="Open camera settings"
        @click="emit('open-settings')"
      >
        <UIcon name="i-lucide-sliders-horizontal" class="size-4" />
        <span class="text-[10px] font-medium tracking-wider">MORE</span>
      </button>
    </div>
  </div>
</template>
