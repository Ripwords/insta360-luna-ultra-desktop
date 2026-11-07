/**
 * The page OBS's Browser Source loads from the webcam server. It decodes the
 * raw Annex-B stream with WebCodecs, as the app's own viewfinder does, so OBS
 * shows each picture as soon as it arrives instead of buffering like a Media
 * Source. Bundled by scripts/build-obs-player.mjs; nothing from Vue or Nuxt.
 */
import { AnnexBDecoder } from "../utils/annexBDecoder";

const STREAM_PATH = "/webcam.h265";
/** Wait before reconnecting after the stream ends or fails. */
const RETRY_MS = 500;

const canvas = document.querySelector("canvas");
const message = document.querySelector("p");
const context = canvas?.getContext("2d");

function show(text: string) {
  if (message) message.textContent = text;
}

function paint(frame: VideoFrame) {
  if (canvas && context) {
    if (canvas.width !== frame.displayWidth) canvas.width = frame.displayWidth;
    if (canvas.height !== frame.displayHeight) canvas.height = frame.displayHeight;
    context.drawImage(frame, 0, 0);
    show("");
  }
  frame.close();
}

let fatal = false;
const decoder = new AnnexBDecoder({
  frame: paint,
  fatal: (text) => {
    fatal = true;
    show(text);
  },
});

/** Reads one connection until it ends. */
async function play() {
  const response = await fetch(STREAM_PATH, { cache: "no-store" });
  const reader = response.ok ? response.body?.getReader() : undefined;
  if (!reader) return;
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    if (value && !decoder.push(value)) {
      await reader.cancel();
      return;
    }
  }
}

async function run() {
  if (!("VideoDecoder" in globalThis)) {
    show("This OBS can't decode video in a Browser Source. Update OBS to version 30 or later.");
    return;
  }
  while (!fatal) {
    try {
      await play();
    } catch {
      // Webcam mode is off or the app is closed: keep trying.
    }
    if (fatal) return;
    decoder.reset();
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
}

void run();
