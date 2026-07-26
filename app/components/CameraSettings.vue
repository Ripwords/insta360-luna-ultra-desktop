<script setup lang="ts">
import {
  colorModesFor,
  filterHasIntensity,
  supportsColorMode,
  supportsFilter,
} from "~/utils/cameraCapabilities";
import { CONTROL_SECTIONS, type Control, type ControlSection } from "~/utils/cameraControls";
import { optionLabel, visibleEnumNames } from "~/utils/cameraLabels";
import { FEATURES } from "~/utils/features";
import type { ProtoValue } from "~/utils/lunaProto";

const {
  settings,
  device,
  saving,
  status,
  update,
  updateDevice,
  setWhiteBalance,
  setColorMode,
  setFilter,
  setFilterIntensity,
} = useCameraSettings();
const { modeId } = useCameraCapture();

/**
 * Each control reports what the camera said when the value was read straight
 * back, because plenty of these change nothing you can see in the preview.
 */
const VERDICTS = {
  applied: { icon: "i-lucide-check", color: "text-success", hint: "Read back from the camera" },
  differs: {
    icon: "i-lucide-arrow-left-right",
    color: "text-warning",
    hint: "Camera chose a different value",
  },
  assumed: {
    icon: "i-lucide-circle-help",
    color: "text-muted",
    hint: "Camera reported nothing — this is its default",
  },
  rejected: { icon: "i-lucide-x", color: "text-error", hint: "Camera refused it" },
} as const;

const verdict = (field: string) => {
  const entry = status.value[field];
  return entry ? { ...VERDICTS[entry.outcome], actual: entry.actual } : null;
};

const source = (control: Control) => (control.scope === "device" ? device : settings);
const valueOf = (control: Control) => source(control).value[control.field];

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

const currentFilter = computed(() =>
  settings.value.gamma_mode === undefined ? undefined : String(settings.value.gamma_mode),
);

/**
 * Drop controls behind an off feature flag, and ones the camera has no picker
 * for in its current state. The camera parses every one of these option types
 * regardless, so its `$supported` list cannot tell us any of this — only the
 * manual can, backed by what the camera was measured to do.
 */
const visibleControls = (section: ControlSection): Control[] =>
  section.controls.filter((control) => {
    if (control.field === "color_mode") {
      return FEATURES.colorMode && supportsColorMode(modeId.value);
    }
    // No filters in Dolby Vision, nor above 4K60 — the picker goes with them
    if (control.field === "gamma_mode") {
      return filtersAvailable.value;
    }
    // Strength belongs to the six cinematic filters and nothing else
    if (control.field === "filter_intensity") {
      return filtersAvailable.value && filterHasIntensity(currentFilter.value);
    }
    return true;
  });

const asOptions = (values: string[]) =>
  values.map((value) => ({ label: optionLabel(value), value }));

/**
 * Colour mode's choices narrow with the capture mode (PureVideo cannot do
 * i-Log), so it asks the capability table rather than the raw enum.
 */
const optionsFor = (control: Control) =>
  control.field === "color_mode"
    ? asOptions(colorModesFor(modeId.value))
    : asOptions(visibleEnumNames(control.values!));

const apply = (control: Control, value: ProtoValue) => {
  // White balance and colour profile each need a companion field written in the
  // same request, so they go through dedicated setters rather than the generic
  // single-field write.
  if (control.field === "white_balance") return setWhiteBalance(String(value));
  if (control.field === "color_mode") return setColorMode(String(value));
  // Filter and strength need the colour mode re-asserted alongside them, or the
  // camera stores them without applying while it is in i-Log
  if (control.field === "gamma_mode") return setFilter(String(value));
  if (control.field === "filter_intensity") return setFilterIntensity(String(value));
  return control.scope === "device"
    ? updateDevice(control.option, control.field, value)
    : update(control.option, control.field, value);
};

/**
 * Before any read we know nothing, so leave everything enabled rather than
 * greying out controls that may well work.
 */
const supported = computed(
  () => new Set((settings.value.$supported as string[] | undefined) ?? []),
);
const isSupported = (control: Control) =>
  control.scope === "device" || supported.value.size === 0 || supported.value.has(control.option);

const asString = (control: Control): string | undefined => {
  const value = valueOf(control);
  return value === undefined ? undefined : String(value);
};

const asNumber = (control: Control): number => {
  const value = valueOf(control);
  return typeof value === "number" ? value : Number(value ?? 0);
};
</script>

<template>
  <div class="space-y-8">
    <section v-for="section in CONTROL_SECTIONS" :key="section.title" class="space-y-3">
      <h3 class="text-xs font-medium tracking-wider text-dimmed">
        {{ section.title.toUpperCase() }}
      </h3>

      <div class="grid gap-4 sm:grid-cols-2">
        <UFormField
          v-for="control in visibleControls(section)"
          :key="control.field"
          :help="control.hint"
        >
          <template #label>
            <span class="flex items-center gap-1.5">
              {{ control.label }}
              <UIcon
                v-if="verdict(control.field)"
                :name="verdict(control.field)!.icon"
                :class="verdict(control.field)!.color"
                class="size-3.5"
                :title="
                  verdict(control.field)!.actual
                    ? `${verdict(control.field)!.hint}: ${verdict(control.field)!.actual}`
                    : verdict(control.field)!.hint
                "
              />
            </span>
          </template>

          <USelect
            v-if="control.kind === 'select'"
            :model-value="asString(control)"
            :items="optionsFor(control)"
            :disabled="!isSupported(control) || saving === control.field"
            :loading="saving === control.field"
            class="w-full"
            @update:model-value="(value: string) => apply(control, value)"
          />

          <USwitch
            v-else-if="control.kind === 'toggle'"
            :model-value="Boolean(valueOf(control))"
            :disabled="!isSupported(control) || saving === control.field"
            @update:model-value="(value: boolean) => apply(control, value)"
          />

          <div v-else class="flex flex-wrap gap-1.5">
            <UButton
              v-for="step in control.steps"
              :key="step.value"
              :label="step.label"
              size="xs"
              :color="asNumber(control) === step.value ? 'primary' : 'neutral'"
              :variant="asNumber(control) === step.value ? 'solid' : 'subtle'"
              :disabled="!isSupported(control) || saving === control.field"
              @click="apply(control, step.value)"
            />
          </div>
        </UFormField>
      </div>
    </section>

    <details class="text-sm">
      <summary class="cursor-pointer text-muted">Everything the camera reported</summary>
      <pre class="mt-2 max-h-96 overflow-auto rounded bg-elevated p-3 text-xs">{{
        JSON.stringify({ photography: settings, device }, null, 2)
      }}</pre>
    </details>
  </div>
</template>
