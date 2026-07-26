import {
  MSG,
  OPTION_TYPE,
  PHOTOGRAPHY_OPTION_TYPE,
  decodeMessage,
  encodeMessage,
  enumNames,
  type ProtoObject,
} from "~/utils/lunaProto";
import { getCameraTransport } from "~/utils/transport";

const CODE_SET_OPTIONS = 7;
const CODE_GET_OPTIONS = 8;
const CODE_SET_PHOTOGRAPHY_OPTIONS = 9;
const CODE_GET_PHOTOGRAPHY_OPTIONS = 10;

/**
 * Asking for every option type in one request risks a single unsupported
 * value spoiling the whole reply, which is exactly what the probe was built
 * to avoid. Batch, and merge what comes back.
 */
const BATCH = 12;

const chunk = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, i * size + size),
  );

async function readBatched(
  code: number,
  requestMessage: string,
  responseMessage: string,
  optionTypeEnum: string,
  extra: ProtoObject,
): Promise<ProtoObject> {
  const merged: ProtoObject = {};
  const supported: string[] = [];

  // The trailing *_NUM entries are enum sentinels, not real options
  const types = enumNames(optionTypeEnum).filter((name) => !name.endsWith("_NUM"));

  for (const batch of chunk(types, BATCH)) {
    let response: Uint8Array;
    try {
      response = await getCameraTransport().command(
        code,
        encodeMessage(requestMessage, { option_types: batch, ...extra }),
      );
    } catch {
      continue; // one bad batch must not lose the rest
    }
    if (response.length === 0) continue;
    const decoded = decodeMessage(responseMessage, response);
    for (const name of (decoded.option_types as string[] | undefined) ?? []) supported.push(name);
    Object.assign(merged, (decoded.value as ProtoObject | undefined) ?? {});
  }
  merged.$supported = supported as unknown as ProtoObject[string];
  return merged;
}

export const readPhotographyOptions = (mode: string): Promise<ProtoObject> =>
  readBatched(
    CODE_GET_PHOTOGRAPHY_OPTIONS,
    MSG.GetPhotographyOptions,
    MSG.GetPhotographyOptionsResp,
    PHOTOGRAPHY_OPTION_TYPE,
    { function_mode: mode },
  );

/**
 * Read back a single option. Used to verify a write actually landed: the
 * camera's `success_types` echo says it accepted the request, which is not
 * the same as having applied it.
 */
export async function readPhotographyOption(
  mode: string,
  optionType: string,
): Promise<ProtoObject> {
  const response = await getCameraTransport().command(
    CODE_GET_PHOTOGRAPHY_OPTIONS,
    encodeMessage(MSG.GetPhotographyOptions, {
      option_types: [optionType],
      function_mode: mode,
    }),
  );
  if (response.length === 0) return {};
  const decoded = decodeMessage(MSG.GetPhotographyOptionsResp, response);
  return (decoded.value as ProtoObject | undefined) ?? {};
}

/** Read back one device option, to verify a write the same way settings do. */
export async function readDeviceOption(optionType: string): Promise<ProtoObject> {
  const response = await getCameraTransport().command(
    CODE_GET_OPTIONS,
    encodeMessage(MSG.GetOptions, { option_types: [optionType] }),
  );
  if (response.length === 0) return {};
  const decoded = decodeMessage(MSG.GetOptionsResp, response);
  return (decoded.value as ProtoObject | undefined) ?? {};
}

export const readDeviceOptions = (): Promise<ProtoObject> =>
  readBatched(CODE_GET_OPTIONS, MSG.GetOptions, MSG.GetOptionsResp, OPTION_TYPE, {});

/**
 * Write a patch. The camera answers with the option types it accepted, which
 * is the only trustworthy confirmation — a silent success is not one.
 */
export async function writePhotographyOptions(
  mode: string,
  optionTypes: string[],
  patch: ProtoObject,
): Promise<string[]> {
  const response = await getCameraTransport().command(
    CODE_SET_PHOTOGRAPHY_OPTIONS,
    encodeMessage(MSG.SetPhotographyOptions, {
      option_types: optionTypes,
      value: patch,
      function_mode: mode,
    }),
  );
  if (response.length === 0) return [];
  const decoded = decodeMessage(MSG.SetPhotographyOptionsResp, response);
  return ((decoded.success_types as string[] | undefined) ?? []).map(String);
}

export async function writeDeviceOptions(
  optionTypes: string[],
  patch: ProtoObject,
): Promise<string[]> {
  const response = await getCameraTransport().command(
    CODE_SET_OPTIONS,
    encodeMessage(MSG.SetOptions, { option_types: optionTypes, value: patch }),
  );
  if (response.length === 0) return [];
  const decoded = decodeMessage(MSG.SetOptionsResp, response);
  return ((decoded.option_types as string[] | undefined) ?? []).map(String);
}
