import { describe, expect, it } from "vitest";
import { encodeGimbalAction, encodeGimbalMove, GIMBAL_ACTION } from "~/utils/gimbal";

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ");

describe("encodeGimbalMove", () => {
  // Bodies the official app sent, from Insta360Linker's packet capture. The
  // capture names the axes by wire field: x is field 1 (tilt), y is field 2 (pan).
  it.each([
    { pan: 0, tilt: 36, wire: "08 01 12 02 08 48" },
    { pan: 0, tilt: 59, wire: "08 01 12 02 08 76" },
    { pan: 10, tilt: 90, wire: "08 01 12 05 08 b4 01 10 14" },
    { pan: 13, tilt: 98, wire: "08 01 12 05 08 c4 01 10 1a" },
    { pan: 96, tilt: -21, wire: "08 01 12 05 08 29 10 c0 01" },
  ])("matches the capture for pan $pan, tilt $tilt", ({ pan, tilt, wire }) => {
    expect(hex(encodeGimbalMove(pan, tilt))).toBe(wire);
  });

  it("stops with the empty vector", () => {
    expect(hex(encodeGimbalMove(0, 0))).toBe("08 01 12 00");
  });

  it("encodes a pure pan in field 2", () => {
    expect(hex(encodeGimbalMove(60, 0))).toBe("08 01 12 02 10 78");
    expect(hex(encodeGimbalMove(-60, 0))).toBe("08 01 12 02 10 77");
  });

  it("clamps to the joystick range and rounds", () => {
    expect(encodeGimbalMove(250, -250)).toEqual(encodeGimbalMove(100, -100));
    expect(encodeGimbalMove(12.4, 0)).toEqual(encodeGimbalMove(12, 0));
  });
});

describe("encodeGimbalAction", () => {
  it("encodes recenter as the captured 08 02", () => {
    expect(hex(encodeGimbalAction(GIMBAL_ACTION.RECENTER))).toBe("08 02");
  });

  it("encodes flip as 08 03", () => {
    expect(hex(encodeGimbalAction(GIMBAL_ACTION.FLIP))).toBe("08 03");
  });
});
