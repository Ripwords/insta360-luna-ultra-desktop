#!/usr/bin/env node
// Trims scripts/luna-protocol-schema.json (the full extraction, 114 KB) down
// to what the app actually needs, and writes it into app/assets.
//
//   node scripts/build-schema.mjs

import fs from "node:fs";
import path from "node:path";

const ROOTS = [
  "insta360.messages.Options",
  "insta360.messages.PhotographyOptions",
  "insta360.messages.GetOptions",
  "insta360.messages.GetOptionsResp",
  "insta360.messages.SetOptions",
  "insta360.messages.SetOptionsResp",
  "insta360.messages.GetPhotographyOptions",
  "insta360.messages.GetPhotographyOptionsResp",
  "insta360.messages.SetPhotographyOptions",
  "insta360.messages.SetPhotographyOptionsResp",
  "insta360.messages.GetCurrentCaptureStatusResp",
  "insta360.messages.CameraCaptureStatus",
  "insta360.messages.StartCapture",
  "insta360.messages.StopCapture",
  "insta360.messages.TakePicture",
];

/** Enums reachable only through option-type lists, not through a field. */
const EXTRA_ENUMS = [
  "insta360.messages.OptionType",
  "insta360.messages.PhotographyOptionType",
  "insta360.messages.FunctionMode",
  "insta360.messages.CaptureMode",
  "insta360.messages.VideoSubMode",
  "insta360.messages.PhotoSubMode",
];

/**
 * Enums this camera numbers differently from the vendored extraction.
 *
 * The extraction is 2020-era and the Luna Ultra is not; where the two disagree,
 * the camera wins. Corrections live here rather than in the extraction itself so
 * that file stays a faithful record of what the vendor's protos say, and so each
 * override can carry the evidence that justifies it.
 *
 * Each entry REPLACES the enum outright — a merge would leave the stale numbers
 * behind, and a stale number that still resolves is worse than one that doesn't.
 */
const ENUM_OVERRIDES = {
  // Measured on firmware v1.0.238 by switching the mode on the camera and
  // diffing `color_mode` before and after (scripts/probe-colorspace.mjs):
  //
  //   Standard -> i-Log         color_mode  1 -> 2
  //   Standard -> Dolby Vision  color_mode  1 -> 5
  //
  // The extraction claimed NORMAL=0, LOG=1, VIVID=2, HDR=3. Every value had
  // shifted, so "i-Log" went out as 1 and put the camera in Standard, and the
  // camera's resting 1 read back as "i-Log" while it was plainly in Standard.
  //
  // 0, 3 and 4 were never observed and are deliberately left unnamed: an
  // unnamed value decodes to its number, which reads as "we don't know this"
  // instead of quietly mislabelling itself. There is no VIVID on this camera.
  "insta360.messages.PhotographyOptions.COLOR_MODE": {
    1: "COLOR_MODE_NORMAL",
    2: "COLOR_MODE_LOG",
    5: "COLOR_MODE_HDR",
  },

  // GammaMode is not a gamma curve on this camera — it is the Filter picker,
  // the Leica and cinematic looks. Measured on firmware v1.0.238 by stepping the
  // camera through all nine filters and diffing (probe-colorspace.mjs `series`).
  //
  // The extraction described a 2020 camera: STANDARD=0, LOG=1, VIVID=2, FLAT=3
  // then Urban/OceanBlue/Snow/Biking/NightLight up to 13. Not one of those
  // numbers is a filter here, and nothing at all lives on 1-13 — which is why
  // the app's "Gamma" dropdown offered four looks the camera does not have.
  //
  // The numbering is genuinely not contiguous, and Leica Chrome genuinely sits
  // at 36 among the film filters rather than beside its two siblings at 15/16.
  // Both were re-measured to be sure. Unobserved numbers stay unnamed.
  "insta360.messages.GammaMode": {
    0: "FILTER_NONE",
    15: "FILTER_LEICA_NATURAL",
    16: "FILTER_LEICA_VIVID",
    24: "FILTER_NC_FILM",
    26: "FILTER_CC_FILM",
    34: "FILTER_POS_FILM",
    35: "FILTER_NEG_FILM",
    36: "FILTER_LEICA_CHROME",
    37: "FILTER_CINEMATIC",
    38: "FILTER_FRESH",
  },

  // Wholly new: the extraction has no filter-intensity enum at all. Measured by
  // holding one cinematic filter and stepping only its strength, which moved
  // field 104 through 1/2/3 while gamma_mode stayed put. 0 was never observed.
  "insta360.messages.FilterIntensity": {
    1: "INTENSITY_LOW",
    2: "INTENSITY_MEDIUM",
    3: "INTENSITY_HIGH",
  },

  // Also wholly new. Pano is a SINGLE sub-mode (photo_sub_mode = 8, itself a
  // value the extraction cannot name) with an aspect setting, which is why the
  // extraction only ever had one PHOTO_INSTA_PANO and no notion of variants.
  //
  // Field 98 carries that aspect: 1 for 360, 4 for 2:1. It was separated from
  // its co-travellers by a negative control — changing the photo resolution in
  // ordinary Photo mode moved `photo_resolution` and `remaining_time` while
  // field 98 stayed at 1, so it tracks the aspect and not the shot size.
  //
  // 2, 3 and anything above 4 were never observed and stay unnamed.
  "insta360.messages.PanoAspect": {
    1: "PANO_ASPECT_360",
    4: "PANO_ASPECT_2_1",
  },

  // Measured by switching the capture mode on the camera and reading
  // `photo_sub_mode` back: Photo is 0, Pano is 8. The extraction puts
  // PHOTO_INSTA_PANO on 5, so selecting Pano sent 5, the camera did not
  // recognise it, and it sat in ordinary Photo mode looking like the feature was
  // broken. Everything downstream failed with it — pano_aspect was rejected
  // because the camera was never in Pano to apply it to.
  //
  // 100 is inferred rather than measured: `video_sub_mode` was observed at 100
  // for VIDEO_NONE, and mode detection needs a "nothing selected" sentinel to
  // test against. Every other stills mode this camera has (UltraPhoto in
  // particular) is unmeasured and deliberately absent.
  "insta360.messages.PhotoSubMode": {
    0: "PHOTO_SINGLE",
    8: "PHOTO_INSTA_PANO",
    100: "PHOTO_NONE",
  },
};

/**
 * Enum values this firmware adds to an enum the extraction otherwise gets right.
 *
 * Unlike ENUM_OVERRIDES these MERGE, because the existing entries are still
 * correct and only need extending.
 */
const ENUM_ADDITIONS = {
  // Resolutions this camera has and the extraction does not, each named from
  // what the camera's own screen showed while it was selected. The camera reuses
  // the extraction's id where one exists (3K 1:1 at 30 is still 121) and numbers
  // the rest from 258 upward, so these extend rather than replace.
  //
  "insta360.messages.VideoResolution": {
    258: "RES_3840_2160P48",
    260: "RES_1920_1080P48",
    433: "RES_3840_1632P120",
    434: "RES_3840_1632P100",
    435: "RES_3840_1632P60",
    437: "RES_3840_1632P48",
    438: "RES_3840_1632P30",
    439: "RES_3840_1632P25",
    440: "RES_3840_1632P24",
    446: "RES_3072_3072P60",
    447: "RES_3072_3072P50",
    436: "RES_3840_1632P50",
    // 2.7K is 2688x1520. Note 48fps sits outside the run at 331, the same way
    // every other 48fps variant is numbered apart from its family.
    242: "RES_2688_1520P120",
    243: "RES_2688_1520P100",
    244: "RES_2688_1520P60",
    245: "RES_2688_1520P50",
    331: "RES_2688_1520P48",
    246: "RES_2688_1520P30",
    247: "RES_2688_1520P25",
    248: "RES_2688_1520P24",
  },

  // Option type 104 carries filter intensity. Confirmed by asking for type 104
  // on its own and getting field 104 back — this protocol numbers option types
  // to match field numbers, and the `scan` sweep found that true for all 60
  // types this firmware has beyond the extraction's 54.
  "insta360.messages.PhotographyOptionType": {
    91: "DEEP_TRACK",
    98: "PANO_ASPECT",
    104: "FILTER_INTENSITY",
  },
};

/**
 * Fields this firmware has that the extraction's messages do not.
 *
 * Same reasoning as the enum overrides, one level down: without an entry here a
 * field decodes into `$unknown` and cannot be written at all, because encoding
 * resolves field numbers by name.
 */
const MESSAGE_ADDITIONS = {
  // The three fields we cannot name are `unknown_*` on purpose. We know their
  // values, not their meaning, and writing Deep Track is a read-modify-write
  // that carries them back untouched — a confident wrong name is what made
  // gamma_mode look like a gamma curve for months.
  "insta360.messages.DeepTrack": {
    1: { name: "unknown_1", type: "uint32", repeated: false },
    2: { name: "unknown_2", type: "uint32", repeated: false },
    3: { name: "unknown_3", type: "uint32", repeated: false },
    // Left as a raw number on purpose. Toggling Deep Track on the camera drives
    // this 2 <-> 5, so it tracks the feature — but writing it comes back
    // `differs`, and the value read on connect did not match what the camera was
    // doing. So this reports STATUS we cannot yet interpret, not a setting, and
    // naming 2 "off" and 5 "on" would be asserting a direction we got wrong once
    // already. An unnamed number reads as "we don't know this", which is true.
    4: { name: "state", type: "uint32", repeated: false },
  },

  "insta360.messages.PhotographyOptions": {
    91: {
      name: "deep_track",
      type: "message",
      repeated: false,
      ref: "insta360.messages.DeepTrack",
    },
    98: {
      name: "pano_aspect",
      type: "enum",
      repeated: false,
      ref: "insta360.messages.PanoAspect",
    },
    104: {
      name: "filter_intensity",
      type: "enum",
      repeated: false,
      ref: "insta360.messages.FilterIntensity",
    },
  },
};

const full = JSON.parse(fs.readFileSync("scripts/luna-protocol-schema.json", "utf8"));

const messages = new Set();
const enums = new Set(EXTRA_ENUMS);

function walk(name) {
  if (messages.has(name) || !full.messages[name]) return;
  messages.add(name);
  for (const field of Object.values(full.messages[name])) {
    if (!field.ref) continue;
    if (full.messages[field.ref]) walk(field.ref);
    else if (full.enums[field.ref]) enums.add(field.ref);
  }
}
for (const root of ROOTS) walk(root);

const missing = ROOTS.filter((root) => !full.messages[root]);
if (missing.length > 0) {
  console.error("missing roots:", missing);
  process.exit(1);
}

// An override for an enum the app never reaches is dead weight that still reads
// as applied. Wholly new enums are exempt: they are pulled in by MESSAGE_ADDITIONS
// below, which walk() cannot see because it only reads the extraction.
const ADDED_REFS = Object.values(MESSAGE_ADDITIONS).flatMap((fields) =>
  Object.values(fields)
    .map((field) => field.ref)
    .filter(Boolean),
);
for (const ref of ADDED_REFS) {
  // A ref is either a message this file defines outright (Deep Track's nested
  // payload has no entry in the extraction at all) or an enum the overrides
  // above supply. Either way it is genuinely used, so register it.
  if (MESSAGE_ADDITIONS[ref]) messages.add(ref);
  else enums.add(ref);
}

const unusedOverrides = Object.keys(ENUM_OVERRIDES).filter((n) => !enums.has(n));
const unusedAdditions = Object.keys(ENUM_ADDITIONS).filter((n) => !enums.has(n));
const unusedMessages = Object.keys(MESSAGE_ADDITIONS).filter((n) => !messages.has(n));
if (unusedOverrides.length + unusedAdditions.length + unusedMessages.length > 0) {
  console.error("firmware corrections target things the app does not use:", {
    enums: [...unusedOverrides, ...unusedAdditions],
    messages: unusedMessages,
  });
  process.exit(1);
}

const trimmed = {
  messages: Object.fromEntries(
    [...messages]
      .sort()
      .map((n) => [n, { ...full.messages[n], ...MESSAGE_ADDITIONS[n] }]),
  ),
  enums: Object.fromEntries(
    [...enums]
      .sort()
      .filter((n) => full.enums[n] || ENUM_OVERRIDES[n])
      .map((n) => [n, { ...(ENUM_OVERRIDES[n] ?? full.enums[n]), ...ENUM_ADDITIONS[n] }]),
  ),
};

const out = path.join("app", "assets", "luna-protocol-schema.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(trimmed));
console.log(
  `wrote ${out}: ${messages.size} messages, ${enums.size} enums, ` +
    `${fs.statSync(out).size} bytes`,
);
for (const name of Object.keys(ENUM_OVERRIDES)) {
  console.log(`  enum replaced: ${name} (firmware numbering, not the extraction's)`);
}
for (const name of Object.keys(ENUM_ADDITIONS)) console.log(`  enum extended: ${name}`);
for (const name of Object.keys(MESSAGE_ADDITIONS)) console.log(`  fields added:  ${name}`);
