#!/usr/bin/env bash
# Regenerate the raw Annex-B fixtures that webcam::nal tests against.
#
# Every clip is 2 s of testsrc2 at 30 fps (60 pictures), written as a raw
# elementary stream with no container. The exact commands are:
#
#   SRC="-f lavfi -i testsrc2=size=1280x720:rate=30 -t 2"
#   ENC="-an -preset ultrafast -crf 42"
#
#   hevc-idr.h265:
#     ffmpeg $SRC $ENC -c:v libx265 \
#       -x265-params keyint=30:open-gop=0:repeat-headers=1 -f hevc hevc-idr.h265
#   hevc-cra-aud.h265:
#     ffmpeg $SRC $ENC -c:v libx265 \
#       -x265-params keyint=30:open-gop=1:aud=1:repeat-headers=1 -f hevc hevc-cra-aud.h265
#   hevc-slices.h265:
#     ffmpeg $SRC $ENC -c:v libx265 \
#       -x265-params keyint=30:open-gop=0:repeat-headers=1:slices=4 -f hevc hevc-slices.h265
#   hevc-switch.h265 (a 1280x720 clip, then a 720x1280 clip, joined with cat):
#     ffmpeg $SRC $ENC -c:v libx265 \
#       -x265-params keyint=30:open-gop=0:repeat-headers=1 -f hevc landscape.h265
#     ffmpeg -f lavfi -i testsrc2=size=720x1280:rate=30 -t 2 $ENC -c:v libx265 \
#       -x265-params keyint=30:open-gop=0:repeat-headers=1 -f hevc portrait.h265
#     cat landscape.h265 portrait.h265 > hevc-switch.h265
#   h264-idr.h264:
#     ffmpeg $SRC $ENC -c:v libx264 -pix_fmt yuv420p -bsf:v h264_mp4toannexb \
#       -f h264 h264-idr.h264
#
# Usage: scripts/make-webcam-fixtures.sh  (needs ffmpeg with libx264/libx265 on PATH)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$root/src-tauri/tests/fixtures"
mkdir -p "$out"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

src=(-f lavfi -i testsrc2=size=1280x720:rate=30 -t 2)
src_portrait=(-f lavfi -i testsrc2=size=720x1280:rate=30 -t 2)
enc=(-an -preset ultrafast -crf 42)

ff() {
  ffmpeg -hide_banner -loglevel error -y "$@"
}

ff "${src[@]}" "${enc[@]}" -c:v libx265 \
  -x265-params keyint=30:open-gop=0:repeat-headers=1 -f hevc "$out/hevc-idr.h265"

ff "${src[@]}" "${enc[@]}" -c:v libx265 \
  -x265-params keyint=30:open-gop=1:aud=1:repeat-headers=1 -f hevc "$out/hevc-cra-aud.h265"

ff "${src[@]}" "${enc[@]}" -c:v libx265 \
  -x265-params keyint=30:open-gop=0:repeat-headers=1:slices=4 -f hevc "$out/hevc-slices.h265"

ff "${src[@]}" "${enc[@]}" -c:v libx265 \
  -x265-params keyint=30:open-gop=0:repeat-headers=1 -f hevc "$work/landscape.h265"
ff "${src_portrait[@]}" "${enc[@]}" -c:v libx265 \
  -x265-params keyint=30:open-gop=0:repeat-headers=1 -f hevc "$work/portrait.h265"
cat "$work/landscape.h265" "$work/portrait.h265" > "$out/hevc-switch.h265"

ff "${src[@]}" "${enc[@]}" -c:v libx264 -pix_fmt yuv420p -bsf:v h264_mp4toannexb \
  -f h264 "$out/h264-idr.h264"

limit=$((300 * 1024))
for f in hevc-idr.h265 hevc-cra-aud.h265 hevc-slices.h265 hevc-switch.h265 h264-idr.h264; do
  size=$(wc -c < "$out/$f" | tr -d ' ')
  if [ "$size" -ge "$limit" ]; then
    echo "$f is $size bytes, over the 300 KB limit" >&2
    exit 1
  fi
  echo "$f: $size bytes"
done
