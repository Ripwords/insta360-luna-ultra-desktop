import {
  concatBytes,
  encodeLengthDelimited,
  encodeTag,
  encodeVarint,
  WIRE_VARINT,
  zigzagEncode,
} from "~/utils/protobuf";
import { getCameraTransport } from "~/utils/transport";

/**
 * PHONE_COMMAND_GIMBAL_CONTROL. The vendored schema has no gimbal messages at
 * all — it was extracted from a camera without one — so the number and the
 * body come from packet captures of the official app on a Luna Ultra
 * (wuhaiqi0621/Insta360Linker, apatassini/Insta360luna), and checked again
 * on a real camera with the preview running.
 */
export const CODE_GIMBAL_CONTROL = 226;

/** Field 1 of the body: what the gimbal should do. */
export const GIMBAL_ACTION = {
  /** A continuous joystick vector in field 2. The zero vector stops. */
  MOVE: 1,
  /** Back to centre, on whichever side (front or selfie) the camera faces. */
  RECENTER: 2,
  /** Half a turn between front and selfie. A toggle: send it again to return. */
  FLIP: 3,
} as const;

/** Joystick range on both axes, as the official app sends it. */
export const GIMBAL_RANGE = 100;

const clamp = (value: number): number =>
  Math.max(-GIMBAL_RANGE, Math.min(GIMBAL_RANGE, Math.round(value)));

/**
 * A move at `pan` / `tilt` speed, each -100..100. Positive pan turns right,
 * positive tilt looks up.
 *
 * On the wire the axes are swapped: field 1 of the nested vector is tilt and
 * field 2 is pan, both protobuf sint32 (ZigZag). A zero axis is left out, so
 * the stop vector is `08 01 12 00`. Matched byte for byte against the capture.
 */
export function encodeGimbalMove(pan: number, tilt: number): Uint8Array {
  const tiltValue = clamp(tilt);
  const panValue = clamp(pan);
  const axes: number[] = [];
  if (tiltValue !== 0)
    axes.push(...encodeTag(1, WIRE_VARINT), ...encodeVarint(zigzagEncode(tiltValue)));
  if (panValue !== 0)
    axes.push(...encodeTag(2, WIRE_VARINT), ...encodeVarint(zigzagEncode(panValue)));
  return concatBytes([
    [...encodeTag(1, WIRE_VARINT), ...encodeVarint(GIMBAL_ACTION.MOVE)],
    encodeLengthDelimited(2, new Uint8Array(axes)),
  ]);
}

/** A one-shot action with no vector: recenter or flip. */
export function encodeGimbalAction(action: number): Uint8Array {
  return concatBytes([[...encodeTag(1, WIRE_VARINT), ...encodeVarint(action)]]);
}

export async function sendGimbalMove(pan: number, tilt: number): Promise<void> {
  await getCameraTransport().command(CODE_GIMBAL_CONTROL, encodeGimbalMove(pan, tilt));
}

export async function sendGimbalAction(action: number): Promise<void> {
  await getCameraTransport().command(CODE_GIMBAL_CONTROL, encodeGimbalAction(action));
}
