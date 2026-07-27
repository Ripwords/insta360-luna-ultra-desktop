import { decodeMessage, encodeMessage, MSG, type ProtoObject } from "#layer/utils/lunaProto";

const CODE_TAKE_PICTURE = 3;
const CODE_START_CAPTURE = 4;
const CODE_STOP_CAPTURE = 5;
const CODE_SET_OPTIONS = 7;
const CODE_GET_OPTIONS = 8;
const CODE_SET_PHOTOGRAPHY_OPTIONS = 9;
const CODE_GET_PHOTOGRAPHY_OPTIONS = 10;
const CODE_GET_CURRENT_CAPTURE_STATUS = 15;

const asStringArray = (value: ProtoObject[string]): string[] =>
  Array.isArray(value) ? value.map(String) : [];

/**
 * The real camera stores photography options per function-mode, so the mock
 * keys them the same way — otherwise a setting changed in one mode would
 * wrongly appear in another and the demo would teach the wrong model.
 */
/**
 * The pro bar's chips read "Auto"/"—" until something has been written for
 * the current mode, which is a fine empty state on real hardware but reads
 * as an unconfigured demo. Seeding the default video mode with a few settled
 * choices — mirroring exactly what a real write would have left behind —
 * makes the embed look like a camera someone has actually been shooting
 * with. Deliberately partial: only the fields the pro bar visibly renders
 * as a placeholder when unset (see CameraProBar.vue's `chips` computed).
 */
const SEEDED_MODE = "FUNCTION_MODE_NORMAL_VIDEO";
const SEEDED_OPTIONS: ProtoObject = {
  color_mode: "COLOR_MODE_NORMAL",
  white_balance: "WB_5000K",
  white_balance_value: 5000,
  gamma_mode: "FILTER_LEICA_NATURAL",
};

export function createCommandChannel() {
  const options: ProtoObject = {};
  const perMode = new Map<string, ProtoObject>([[SEEDED_MODE, { ...SEEDED_OPTIONS }]]);
  let recording = false;
  let recordingStartedAt = 0;

  return async function command(code: number, body: Uint8Array): Promise<Uint8Array> {
    switch (code) {
      case CODE_SET_OPTIONS: {
        const request = decodeMessage(MSG.SetOptions, body);
        const optionTypes = asStringArray(request.option_types);
        Object.assign(options, (request.value as ProtoObject | undefined) ?? {});
        // Echoing back the requested types is what tells writeDeviceOptions
        // the write was accepted — an empty reply reads as a rejection and
        // useCameraSettings reverts the optimistic update.
        return encodeMessage(MSG.SetOptionsResp, { option_types: optionTypes });
      }

      case CODE_GET_OPTIONS:
        return encodeMessage(MSG.GetOptionsResp, { value: options });

      case CODE_SET_PHOTOGRAPHY_OPTIONS: {
        const request = decodeMessage(MSG.SetPhotographyOptions, body);
        const mode = String(request.function_mode ?? "unknown");
        const optionTypes = asStringArray(request.option_types);
        const current = perMode.get(mode) ?? {};
        Object.assign(current, (request.value as ProtoObject | undefined) ?? {});
        perMode.set(mode, current);
        // The schema names this field `success_types`, not `option_types` —
        // writePhotographyOptions reads exactly that field to decide whether
        // the write landed, so getting the name wrong silently breaks every
        // write-then-verify round trip in the pro bar.
        return encodeMessage(MSG.SetPhotographyOptionsResp, { success_types: optionTypes });
      }

      case CODE_GET_PHOTOGRAPHY_OPTIONS: {
        const request = decodeMessage(MSG.GetPhotographyOptions, body);
        const mode = String(request.function_mode ?? "unknown");
        return encodeMessage(MSG.GetPhotographyOptionsResp, {
          value: perMode.get(mode) ?? {},
        });
      }

      case CODE_START_CAPTURE:
        recording = true;
        recordingStartedAt = Date.now();
        return new Uint8Array(0);

      case CODE_STOP_CAPTURE:
        recording = false;
        return new Uint8Array(0);

      case CODE_TAKE_PICTURE:
        return new Uint8Array(0);

      case CODE_GET_CURRENT_CAPTURE_STATUS:
        return encodeMessage(MSG.GetCurrentCaptureStatusResp, {
          status: {
            state: recording ? "NORMAL_CAPTURE" : "NOT_CAPTURE",
            capture_time: recording ? Math.floor((Date.now() - recordingStartedAt) / 1000) : 0,
          },
        });

      default:
        return new Uint8Array(0);
    }
  };
}
