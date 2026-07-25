<script setup lang="ts">
import {
  isoLabel,
  isoSteps,
  optionLabel,
  shutterLabel,
  shutterNameForSeconds,
  shutterSteps,
} from "~/utils/cameraLabels";
import {
  colorModesFor,
  filterHasIntensity,
  supportsColorMode,
  supportsFilter,
  supportsPanoAspect,
} from "~/utils/cameraCapabilities";
import { enumNames } from "~/utils/lunaProto";
import { FEATURES } from "~/utils/features";
import type { ProtoObject } from "~/utils/lunaProto";

/**
 * The Pro row from the phone app: a strip of chips showing each setting's
 * current value, one of which expands into a wheel. Only one wheel is open at
 * a time, which is what keeps the row readable on a narrow window.
 */
const { settings, saving, status, update, setExposure, setWhiteBalanceKelvin, setColorMode } =
  useCameraSettings();
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
  return true;
}));

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
    <div
      v-if="open"
      class="rounded-xl bg-black/60 p-1.5 backdrop-blur-md"
    >
      <CameraWheel
        v-if="open === 'iso'"
        :steps="isoSteps()"
        :model-value="String(manualIso)"
        :busy="busy('iso')"
        @update:model-value="(value) => setExposure({ iso: Number(value) })"
      />
      <CameraWheel
        v-else-if="open === 'shutter'"
        :steps="shutterSteps()"
        :model-value="manualShutter"
        :busy="busy('shutter')"
        @update:model-value="(value) => setExposure({ shutter_speed: value })"
      />
      <CameraWheel
        v-else-if="open === 'ev'"
        :steps="evSteps"
        :model-value="String(settings.exposure_bias ?? 0)"
        :busy="busy('ev')"
        @update:model-value="(value) => update('EXPOSURE_BIAS', 'exposure_bias', Number(value))"
      />
      <CameraWheel
        v-else-if="open === 'colour'"
        :steps="colourSteps"
        :model-value="settings.color_mode ? String(settings.color_mode) : undefined"
        :busy="busy('colour')"
        @update:model-value="(value) => setColorMode(value)"
      />
      <CameraWheel
        v-else-if="open === 'filter'"
        :steps="filterSteps"
        :model-value="currentFilter ?? 'FILTER_NONE'"
        :busy="busy('filter')"
        @update:model-value="(value) => update('VIDEO_GAMMA_MODE', 'gamma_mode', value)"
      />
      <CameraWheel
        v-else-if="open === 'strength'"
        :steps="strengthSteps"
        :model-value="settings.filter_intensity ? String(settings.filter_intensity) : undefined"
        :busy="busy('strength')"
        @update:model-value="(value) => update('FILTER_INTENSITY', 'filter_intensity', value)"
      />
      <CameraWheel
        v-else-if="open === 'aspect'"
        :steps="aspectSteps"
        :model-value="settings.pano_aspect ? String(settings.pano_aspect) : undefined"
        :busy="busy('aspect')"
        @update:model-value="(value) => update('PANO_ASPECT', 'pano_aspect', value)"
      />
      <CameraWheel
        v-else-if="open === 'wb'"
        :steps="wbSteps"
        :model-value="String(wbKelvin)"
        :busy="busy('wb')"
        @update:model-value="(value) => selectWb(Number(value))"
      />
      <CameraWheel
        v-else-if="open === 'sharpness'"
        :steps="sharpnessSteps"
        :model-value="String(settings.sharpness ?? 0)"
        :busy="busy('sharpness')"
        @update:model-value="(value) => update('SHARPNESS', 'sharpness', Number(value))"
      />
    </div>

    <p
      v-if="(open === 'iso' && isoAuto) || (open === 'shutter' && shutterAuto)"
      class="rounded-lg bg-black/50 px-2 py-1 text-center text-xs text-white/70 backdrop-blur-md"
    >
      Pick a value to take this off Auto; leave both on Auto for full auto exposure.
    </p>

    <div class="flex items-stretch gap-0.5 overflow-x-auto rounded-xl bg-black/50 p-1 backdrop-blur-md">
      <template v-for="(chip, index) in chips" :key="chip.id">
        <!--
          A hairline wherever the concern changes: exposure, then the look being
          baked in, then image adjustments. Eight chips in one undifferentiated
          row is a list; three groups is a control panel you can scan.
        -->
        <span
          v-if="index > 0 && chip.group !== chips[index - 1]!.group"
          class="my-1.5 w-px shrink-0 bg-white/15"
          aria-hidden="true"
        />
        <button
          type="button"
          class="flex min-w-14 flex-1 flex-col items-center gap-0.5 rounded-lg px-2 py-1.5 transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white"
          :class="open === chip.id ? 'bg-white/20' : 'hover:bg-white/10'"
          :aria-pressed="open === chip.id"
          @click="toggle(chip.id)"
        >
          <span class="flex items-center gap-1 text-[10px] font-medium tracking-wider text-white/50">
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
