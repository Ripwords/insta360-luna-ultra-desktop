import { describe, expect, it } from "vitest";
import {
  buildCodecString,
  detectCodec,
  drainAccessUnits,
  groupAccessUnits,
  nalType,
  splitNalUnits,
} from "~/utils/annexB";

/** Prefix each payload with a 4-byte Annex-B start code and concatenate. */
function annexB(...payloads: number[][]): Uint8Array {
  const out: number[] = [];
  for (const payload of payloads) out.push(0, 0, 0, 1, ...payload);
  return new Uint8Array(out);
}

/**
 * H.265 SPS laid out per ITU-T H.265 7.3.2.2:
 * 2-byte NAL header, then sps_video_parameter_set_id/max_sub_layers/nesting,
 * then profile_tier_level (profile byte, 4 compat bytes, 6 constraint bytes,
 * level byte). These values are the canonical Main profile / level 3.1.
 */
const H265_SPS = [
  0x42,
  0x01, // NAL header, type 33 (SPS)
  0x01, // vps_id 0, max_sub_layers_minus1 0, nesting 1
  0x01, // profile_space 0, tier 0, profile_idc 1 (Main)
  0x60,
  0x00,
  0x00,
  0x00, // general_profile_compatibility_flags
  0xb0,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00, // constraint flags
  0x5d, // general_level_idc 93 -> level 3.1
];
const H265_VPS = [0x40, 0x01, 0x0c];
const H265_IDR = [0x26, 0x01, 0x80]; // type 19 (IDR_W_RADL), first slice in pic
const H265_TRAIL = [0x02, 0x01, 0x80]; // type 1 (TRAIL_R), first slice in pic

/** H.264 SPS: header byte, then profile_idc, constraint flags, level_idc. */
const H264_SPS = [0x67, 0x64, 0x00, 0x28];
const H264_PPS = [0x68, 0xee];
const H264_IDR = [0x65, 0x88]; // type 5, first_mb_in_slice == 0
const H264_NONIDR = [0x41, 0x88]; // type 1, first_mb_in_slice == 0

describe("splitNalUnits", () => {
  it("splits on 4-byte and 3-byte start codes and drops them", () => {
    const stream = new Uint8Array([0, 0, 0, 1, 0xaa, 0xbb, 0, 0, 1, 0xcc]);
    expect(splitNalUnits(stream)).toEqual([new Uint8Array([0xaa, 0xbb]), new Uint8Array([0xcc])]);
  });

  it("ignores leading bytes before the first start code", () => {
    const stream = new Uint8Array([0x99, 0x99, 0, 0, 0, 1, 0xaa]);
    expect(splitNalUnits(stream)).toEqual([new Uint8Array([0xaa])]);
  });

  it("returns nothing for a stream with no start codes", () => {
    expect(splitNalUnits(new Uint8Array([1, 2, 3]))).toEqual([]);
  });
});

describe("detectCodec", () => {
  it("recognises H.265 by its VPS/SPS NAL types", () => {
    expect(detectCodec(splitNalUnits(annexB(H265_VPS, H265_SPS)))).toBe("h265");
  });

  it("recognises H.264 by its SPS/PPS NAL types", () => {
    expect(detectCodec(splitNalUnits(annexB(H264_SPS, H264_PPS)))).toBe("h264");
  });

  it("returns null when no parameter sets are present", () => {
    expect(detectCodec(splitNalUnits(annexB([0x02, 0x01, 0x80])))).toBeNull();
  });
});

describe("nalType", () => {
  it("reads the 6-bit type from the H.265 two-byte header", () => {
    expect(nalType(new Uint8Array(H265_SPS), "h265")).toBe(33);
  });

  it("reads the 5-bit type from the H.264 one-byte header", () => {
    expect(nalType(new Uint8Array(H264_SPS), "h264")).toBe(7);
  });
});

describe("buildCodecString", () => {
  it("derives the canonical Main profile string from an H.265 SPS", () => {
    const units = splitNalUnits(annexB(H265_VPS, H265_SPS));
    expect(buildCodecString(units, "h265")).toBe("hvc1.1.6.L93.B0");
  });

  it("derives avc1.PPCCLL from an H.264 SPS", () => {
    const units = splitNalUnits(annexB(H264_SPS, H264_PPS));
    expect(buildCodecString(units, "h264")).toBe("avc1.640028");
  });

  it("returns null when the SPS is absent", () => {
    expect(buildCodecString(splitNalUnits(annexB(H264_PPS)), "h264")).toBeNull();
  });

  it("returns null when the SPS is truncated", () => {
    const truncated = splitNalUnits(annexB([0x42, 0x01, 0x01]));
    expect(buildCodecString(truncated, "h265")).toBeNull();
  });

  it("strips emulation prevention bytes before parsing", () => {
    // 0x00 0x00 0x03 in the payload encodes a literal 0x00 0x00
    const spsWithEmulation = [
      0x42, 0x01, 0x01, 0x01, 0x60, 0x00, 0x00, 0x03, 0x00, 0xb0, 0x00, 0x00, 0x03, 0x00, 0x00,
      0x00, 0x5d,
    ];
    const units = splitNalUnits(annexB(spsWithEmulation));
    expect(buildCodecString(units, "h265")).toBe("hvc1.1.6.L93.B0");
  });
});

describe("groupAccessUnits", () => {
  it("bundles parameter sets with the following H.265 keyframe", () => {
    const units = splitNalUnits(annexB(H265_VPS, H265_SPS, H265_IDR));
    const access = groupAccessUnits(units, "h265");
    expect(access).toHaveLength(1);
    expect(access[0]!.key).toBe(true);
  });

  it("starts a new H.265 access unit at each first-slice VCL NAL", () => {
    const units = splitNalUnits(annexB(H265_IDR, H265_TRAIL, H265_TRAIL));
    const access = groupAccessUnits(units, "h265");
    expect(access.map((unit) => unit.key)).toEqual([true, false, false]);
  });

  it("marks H.264 IDR units as keyframes and others as delta", () => {
    const units = splitNalUnits(annexB(H264_SPS, H264_PPS, H264_IDR, H264_NONIDR));
    const access = groupAccessUnits(units, "h264");
    expect(access.map((unit) => unit.key)).toEqual([true, false]);
  });

  it("re-emits start codes so the decoder receives valid Annex-B", () => {
    const units = splitNalUnits(annexB(H264_SPS, H264_PPS, H264_IDR));
    const [first] = groupAccessUnits(units, "h264");
    expect(Array.from(first!.data.subarray(0, 5))).toEqual([0, 0, 0, 1, 0x67]);
  });

  it("returns nothing when no VCL NAL has arrived yet", () => {
    const units = splitNalUnits(annexB(H264_SPS, H264_PPS));
    expect(groupAccessUnits(units, "h264")).toEqual([]);
  });
});

describe("drainAccessUnits", () => {
  it("holds back the final picture, which may still be incomplete", () => {
    const units = splitNalUnits(annexB(H265_IDR, H265_TRAIL));
    const { access, pending } = drainAccessUnits(units, "h265");
    expect(access).toHaveLength(1);
    expect(access[0]!.key).toBe(true);
    expect(pending).toHaveLength(1);
  });

  it("emits nothing until a second picture proves the first is complete", () => {
    const units = splitNalUnits(annexB(H265_VPS, H265_SPS, H265_IDR));
    const { access, pending } = drainAccessUnits(units, "h265");
    expect(access).toEqual([]);
    expect(pending).toHaveLength(3);
  });

  it("never drops parameter sets that arrive before any picture", () => {
    const units = splitNalUnits(annexB(H265_VPS, H265_SPS));
    const { access, pending } = drainAccessUnits(units, "h265");
    expect(access).toEqual([]);
    expect(pending).toHaveLength(2);
  });

  it("keeps parameter sets attached to the keyframe across a chunk split", () => {
    // The regression: parameter sets and the IDR arriving in separate reads
    const first = splitNalUnits(annexB(H265_VPS, H265_SPS));
    const drainedFirst = drainAccessUnits(first, "h265");
    expect(drainedFirst.access).toEqual([]);

    const next = [...drainedFirst.pending, ...splitNalUnits(annexB(H265_IDR, H265_TRAIL))];
    const { access } = drainAccessUnits(next, "h265");
    expect(access).toHaveLength(1);
    expect(access[0]!.key).toBe(true);
    // VPS, SPS and the IDR slice must all be in that first access unit
    expect(access[0]!.data.length).toBeGreaterThan(
      H265_VPS.length + H265_SPS.length + H265_IDR.length,
    );
  });

  it("reassembles a picture split across two reads into one access unit", () => {
    const units = splitNalUnits(annexB(H265_IDR, H265_TRAIL, H265_TRAIL));
    const { access, pending } = drainAccessUnits(units, "h265");
    expect(access).toHaveLength(2);
    expect(pending).toHaveLength(1);
  });
});
