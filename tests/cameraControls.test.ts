import { describe, expect, it } from "vitest";
import { WHITE_BALANCE_KELVIN } from "~/utils/cameraControls";
import { enumNames } from "~/utils/lunaProto";

describe("WHITE_BALANCE_KELVIN", () => {
  it("pairs each white balance preset with a Kelvin", () => {
    expect(WHITE_BALANCE_KELVIN.WB_AUTO).toBe(0);
    expect(WHITE_BALANCE_KELVIN.WB_5000K).toBe(5000);
  });

  it("covers every WhiteBalance enum value the camera offers", () => {
    for (const name of enumNames("insta360.messages.PhotographyOptions.WhiteBalance")) {
      expect(WHITE_BALANCE_KELVIN[name], `missing Kelvin for ${name}`).toBeTypeOf("number");
    }
  });
});
