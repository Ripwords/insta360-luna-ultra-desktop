import { MSG, decodeMessage, encodeMessage, type ProtoObject } from "~/utils/lunaProto";
import { getCameraTransport } from "~/utils/transport";

const CODE_TAKE_PICTURE = 3;
const CODE_START_CAPTURE = 4;
const CODE_STOP_CAPTURE = 5;
const CODE_GET_CURRENT_CAPTURE_STATUS = 15;

export interface CaptureStatus {
  /** CameraCaptureState name, e.g. NOT_CAPTURE or NORMAL_CAPTURE. */
  state: string;
  /** Seconds elapsed in the current capture. */
  seconds: number;
  recording: boolean;
}

export async function startCapture(captureMode: string): Promise<void> {
  await getCameraTransport().command(
    CODE_START_CAPTURE,
    encodeMessage(MSG.StartCapture, { mode: captureMode }),
  );
}

export async function stopCapture(captureMode: string): Promise<void> {
  await getCameraTransport().command(
    CODE_STOP_CAPTURE,
    encodeMessage(MSG.StopCapture, { mode: captureMode }),
  );
}

export async function takePicture(mode = "NORMAL"): Promise<void> {
  await getCameraTransport().command(CODE_TAKE_PICTURE, encodeMessage(MSG.TakePicture, { mode }));
}

/**
 * Ask the camera what it is doing. This is the only trustworthy source for
 * whether a recording is running — the record command's reply says only that
 * the request was understood.
 */
export async function readCaptureStatus(): Promise<CaptureStatus> {
  const response = await getCameraTransport().command(
    CODE_GET_CURRENT_CAPTURE_STATUS,
    new Uint8Array(0),
  );
  if (response.length === 0) return { state: "NOT_CAPTURE", seconds: 0, recording: false };

  const decoded = decodeMessage(MSG.GetCurrentCaptureStatusResp, response);
  const status = (decoded.status as ProtoObject | undefined) ?? {};
  const state = String(status.state ?? "NOT_CAPTURE");
  return {
    state,
    seconds: typeof status.capture_time === "number" ? status.capture_time : 0,
    // Anything other than "not capturing" means something is running, which
    // covers modes we have no specific name for yet
    recording: state !== "NOT_CAPTURE" && state !== "SETTINGS_NEW_VALUE",
  };
}
