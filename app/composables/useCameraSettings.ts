import { MSG, isDefaultValue } from "~/utils/lunaProto";
import { WHITE_BALANCE_KELVIN } from "~/utils/cameraControls";
import { shutterSeconds } from "~/utils/cameraLabels";
import type { ProtoObject, ProtoValue } from "~/utils/lunaProto";
import {
  readDeviceOption,
  readDeviceOptions,
  readPhotographyOption,
  readPhotographyOptions,
  writeDeviceOptions,
  writePhotographyOptions,
} from "~/utils/lunaSettings";

/**
 * What we actually know about a write, as opposed to what we hoped.
 * - `applied`   the camera read back the value we asked for
 * - `differs`   it read back something else, which is in `actual`
 * - `assumed`   it omitted the field, which proto3 does for defaults, so we
 *               cannot distinguish "applied the default" from "ignored us"
 * - `rejected`  it did not list the option type as accepted
 */
export type WriteOutcome = "applied" | "differs" | "assumed" | "rejected";

export interface WriteStatus {
  outcome: WriteOutcome;
  actual?: string;
  at: number;
}

export function useCameraSettings() {
  const { isConnected } = useCamera();

  const settings = useState<ProtoObject>("camera-settings", () => ({}));
  const device = useState<ProtoObject>("camera-device-options", () => ({}));
  const mode = useState<string>("camera-settings-mode", () => "FUNCTION_MODE_NORMAL_VIDEO");
  const loading = useState<boolean>("camera-settings-loading", () => false);
  const saving = useState<string | null>("camera-settings-saving", () => null);
  const error = useState<string | null>("camera-settings-error", () => null);
  const status = useState<Record<string, WriteStatus>>("camera-settings-status", () => ({}));

  const setStatus = (field: string, next: Omit<WriteStatus, "at">) => {
    status.value = { ...status.value, [field]: { ...next, at: Date.now() } };
  };

  /**
   * Nested writes like exposure_manual compare as "[object Object]" under
   * String(), which would call every one of them a match. Compare the fields
   * we actually asked for instead, ignoring extras the camera adds.
   */
  const matches = (requested: ProtoValue, actual: ProtoValue): boolean => {
    if (typeof requested === "object" && requested !== null && !Array.isArray(requested)) {
      if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return false;
      const observed = actual as Record<string, ProtoValue | undefined>;
      return Object.entries(requested).every(
        ([key, value]) => value === undefined || String(observed[key]) === String(value),
      );
    }
    return String(requested) === String(actual);
  };

  const describe = (value: ProtoValue): string =>
    typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);

  /**
   * `keepStatus` is for reloads that follow a write we just reported on: the
   * verdict is the only feedback the user gets that the write landed, and
   * throwing it away a moment later reads as the write having been forgotten.
   */
  async function load(options_?: { keepStatus?: boolean }) {
    if (!isConnected.value || loading.value) return;
    loading.value = true;
    error.value = null;
    try {
      const [photography, options] = await Promise.all([
        readPhotographyOptions(mode.value),
        readDeviceOptions(),
      ]);
      settings.value = photography;
      device.value = options;
      // A fresh read supersedes any per-field verdict from earlier writes
      if (!options_?.keepStatus) status.value = {};
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      loading.value = false;
    }
  }

  /**
   * Write a patch of one or more option types, then read the primary field
   * straight back and compare.
   *
   * The write response only proves the camera parsed the request. Several
   * settings produce no visible change in the preview, so the read-back is
   * the only honest evidence that anything happened — and when it disagrees,
   * the camera's own value wins and is shown. Some settings need companion
   * fields written in the same request (see setWhiteBalance/setColorMode),
   * which is why this takes a list of option types and a whole patch; the
   * verdict tracks the `verify` field the user actually chose.
   */
  async function writeAndVerify(
    optionTypes: string[],
    patch: ProtoObject,
    verify: { option: string; field: string },
  ) {
    const { option, field } = verify;
    const previous = { ...settings.value };
    settings.value = { ...settings.value, ...patch };
    saving.value = field;
    error.value = null;
    try {
      const accepted = await writePhotographyOptions(mode.value, optionTypes, patch);
      if (!accepted.includes(option)) {
        settings.value = previous;
        setStatus(field, { outcome: "rejected" });
        error.value = `The camera did not accept ${field}.`;
        return;
      }

      const after = await readPhotographyOption(mode.value, option);
      const actual = after[field];
      if (actual === undefined) {
        // proto3 omits defaults on read-back. If we asked for the default and
        // the camera accepted the option, that silence is exactly what a
        // successful write looks like — call it applied. Only a non-default
        // request that comes back empty is genuinely ambiguous.
        setStatus(field, {
          outcome: isDefaultValue(MSG.PhotographyOptions, field, patch[field]!) ? "applied" : "assumed",
        });
        return;
      }
      settings.value = { ...settings.value, [field]: actual };
      setStatus(
        field,
        matches(patch[field]!, actual)
          ? { outcome: "applied" }
          : { outcome: "differs", actual: describe(actual) },
      );
    } catch (cause) {
      settings.value = previous;
      setStatus(field, { outcome: "rejected" });
      error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      saving.value = null;
    }
  }

  const update = (optionType: string, field: string, value: ProtoValue) =>
    writeAndVerify([optionType], { [field]: value }, { option: optionType, field });

  /**
   * White balance is two rival fields: the preset enum and a free-Kelvin value
   * the camera only honours when the preset is non-auto. Written apart they
   * contradict and the camera falls back to auto, so send the matched pair.
   */
  const setWhiteBalance = (preset: string) =>
    writeAndVerify(
      ["WHITE_BALANCE", "WHITE_BALANCE_VALUE"],
      { white_balance: preset, white_balance_value: WHITE_BALANCE_KELVIN[preset] ?? 0 },
      { option: "WHITE_BALANCE", field: "white_balance" },
    );

  /**
   * The camera's white-balance dial is free Kelvin — Auto plus 2000–10000K in
   * 2000K steps — carried by `white_balance_value`, which the camera only
   * honours when the preset isn't auto. So pair them: 0 → auto, otherwise a
   * non-auto preset flag plus the chosen Kelvin.
   */
  const setWhiteBalanceKelvin = (kelvin: number) =>
    writeAndVerify(
      ["WHITE_BALANCE", "WHITE_BALANCE_VALUE"],
      kelvin === 0
        ? { white_balance: "WB_AUTO", white_balance_value: 0 }
        : { white_balance: "WB_5000K", white_balance_value: kelvin },
      { option: "WHITE_BALANCE_VALUE", field: "white_balance_value" },
    );

  /**
   * Color mode (Standard / i-Log / Dolby Vision). Sent on its own: toggling the
   * mode on the camera and diffing every candidate field showed `color_mode`
   * moving and nothing else — `gamma_mode` in particular stayed put, so the
   * earlier attempt to pair the two was pairing it with a bystander.
   *
   * The camera mirrors this field across all four function modes at once, so
   * writing it for the current mode is enough to set it everywhere.
   */
  async function setColorMode(colorMode: string) {
    await writeAndVerify(
      ["COLOR_MODE"],
      { color_mode: colorMode },
      { option: "COLOR_MODE", field: "color_mode" },
    );
    // Changing the colour mode makes the camera rewrite OTHER settings —
    // `sharpness` was measured moving 1 -> 2 -> 1 across an i-Log -> Standard ->
    // i-Log round trip, and Dolby Vision clears the filter outright. Re-reading
    // only COLOR_MODE would leave the panel showing values the camera has
    // already discarded, so read everything back. The verdict survives, since
    // it is the only evidence the user has that the write landed.
    await load({ keepStatus: true });
  }

  /**
   * Zoom while the dial is moving: write and move on, no read-back.
   *
   * Every other setting is picked once, so writeAndVerify's write-then-read is
   * cheap. A drag emits values continuously, and two round-trips per frame would
   * queue up behind the finger and arrive late. So the drag writes blind and
   * `setZoom` does one verified write when it ends — the verdict then reflects
   * where the dial was let go, which is the only value the user chose.
   *
   * A dropped write mid-drag is not worth surfacing: the next one supersedes it,
   * and an error banner that flickers during a gesture is noise, not news.
   */
  async function nudgeZoom(scale: number) {
    settings.value = { ...settings.value, zoom_scale: scale };
    try {
      await writePhotographyOptions(mode.value, ["ZOOM_SCALE"], { zoom_scale: scale });
    } catch {
      // Superseded by the next frame, or by setZoom when the drag ends
    }
  }

  /** Commit the zoom the drag settled on, verified like any other setting. */
  const setZoom = (scale: number) => update("ZOOM_SCALE", "zoom_scale", scale);

  /**
   * A filter write carries the current colour mode with it, unchanged.
   *
   * On its own, `gamma_mode` is accepted and stored but not applied while the
   * camera is in i-Log: the picture does not change until the colour mode is
   * switched and back, at which point the filter appears. Changing the filter on
   * the camera's own screen applies it immediately, so this is our request being
   * short of something, not a firmware limitation.
   *
   * Re-asserting `color_mode` in the same request is what the manual workaround
   * does — it makes the camera rebuild its colour pipeline, and the filter comes
   * with it. This is the same shape as white balance, which also reconciles
   * itself away unless its companion field arrives in the same write.
   *
   * The pairing is deliberately ONE-WAY. `setColorMode` must keep sending
   * `color_mode` alone: an earlier version bundled `gamma_mode` into it and the
   * colour mode stopped taking. Filter carries colour; colour does not carry
   * filter.
   */
  function withColorMode(optionTypes: string[], patch: ProtoObject): [string[], ProtoObject] {
    const colorMode = settings.value.color_mode;
    // Before the first read there is no colour mode to re-assert, and inventing
    // one would write a mode the user never chose.
    if (colorMode === undefined) return [optionTypes, patch];
    return [[...optionTypes, "COLOR_MODE"], { ...patch, color_mode: String(colorMode) }];
  }

  const setFilter = (filter: string) =>
    writeAndVerify(...withColorMode(["VIDEO_GAMMA_MODE"], { gamma_mode: filter }), {
      option: "VIDEO_GAMMA_MODE",
      field: "gamma_mode",
    });

  /** Strength rides the same pipeline, so it needs the same companion. */
  const setFilterIntensity = (intensity: string) =>
    writeAndVerify(...withColorMode(["FILTER_INTENSITY"], { filter_intensity: intensity }), {
      option: "FILTER_INTENSITY",
      field: "filter_intensity",
    });

  /** The same write-then-verify cycle, for options that live on the device. */
  async function updateDevice(optionType: string, field: string, value: ProtoValue) {
    const previous = device.value[field];
    device.value = { ...device.value, [field]: value };
    saving.value = field;
    error.value = null;
    try {
      const accepted = await writeDeviceOptions([optionType], { [field]: value });
      if (!accepted.includes(optionType)) {
        device.value = { ...device.value, [field]: previous };
        setStatus(field, { outcome: "rejected" });
        error.value = `The camera did not accept ${field}.`;
        return;
      }
      const after = await readDeviceOption(optionType);
      const actual = after[field];
      if (actual === undefined) {
        // Same reasoning as update(): an accepted write of the default value
        // reads back empty and that is success, not uncertainty.
        setStatus(field, {
          outcome: isDefaultValue(MSG.Options, field, value) ? "applied" : "assumed",
        });
        return;
      }
      device.value = { ...device.value, [field]: actual };
      setStatus(
        field,
        matches(value, actual)
          ? { outcome: "applied" }
          : { outcome: "differs", actual: describe(actual) },
      );
    } catch (cause) {
      device.value = { ...device.value, [field]: previous };
      setStatus(field, { outcome: "rejected" });
      error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      saving.value = null;
    }
  }

  /**
   * Drive exposure from the ISO and shutter wheels. Confirmed on-device: the
   * camera's real lever is the per-channel `video_exposure`/`still_exposure`
   * (ExposureOptions { program, iso, shutter_speed in seconds }), not the legacy
   * exposure_manual (which is accepted but reverts).
   *
   * Which wheels are on "Auto" (iso 0, SPEED_AUTO → 0 seconds) picks the program
   * like a PASM dial: both set → MANUAL, ISO auto → SHUTTER_PRIORITY, shutter
   * auto → ISO_PRIORITY, both auto → AUTO. Computing this is what lets a wheel go
   * *back* to Auto — we used to always force MANUAL, so Auto never took.
   */
  async function setExposure(patch: { iso?: number; shutter_speed?: string }) {
    const current = (settings.value.video_exposure as ProtoObject | undefined) ?? {};
    const iso = patch.iso ?? Number(current.iso ?? 0);
    const shutterSecs =
      patch.shutter_speed !== undefined
        ? shutterSeconds(patch.shutter_speed)
        : Number(current.shutter_speed ?? 0);

    const isoAuto = !iso;
    const shutterAuto = !shutterSecs;
    const program = isoAuto && shutterAuto
      ? "AUTO"
      : isoAuto
        ? "SHUTTER_PRIORITY"
        : shutterAuto
          ? "ISO_PRIORITY"
          : "MANUAL";

    const exposureMode = program === "MANUAL" ? "EXP_MODE_MANUAL" : "EXP_MODE_AUTO";
    if (settings.value.exposure_mode !== exposureMode) {
      await update("EXPOSURE_MODE", "exposure_mode", exposureMode);
    }

    const exposure: ProtoObject = { program, iso, shutter_speed: shutterSecs };
    await writeAndVerify(
      ["VIDEO_EXPOSURE_OPTIONS", "STILL_EXPOSURE_OPTIONS"],
      { video_exposure: exposure, still_exposure: exposure },
      { option: "VIDEO_EXPOSURE_OPTIONS", field: "video_exposure" },
    );
  }

  watch(mode, () => void load());

  /**
   * `immediate` matters: you connect on the home page and then navigate here, so
   * by the time this composable initialises `isConnected` is already true and a
   * plain watcher never fires. Settings then stay empty until something writes,
   * which is why the colour mode read "—" until it was set by hand — every other
   * control has a falsy-friendly default ("Auto", "Off") and so looked fine
   * while holding nothing. The live view and capture-status watchers were always
   * immediate; this one being the odd one out is what hid it.
   */
  watch(
    isConnected,
    (connected) => {
      if (connected) void load();
    },
    { immediate: true },
  );

  return {
    settings,
    device,
    mode,
    loading,
    saving,
    error,
    status,
    load,
    update,
    updateDevice,
    setExposure,
    setWhiteBalance,
    setWhiteBalanceKelvin,
    setColorMode,
    setFilter,
    setFilterIntensity,
    nudgeZoom,
    setZoom,
  };
}
