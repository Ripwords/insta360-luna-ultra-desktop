/**
 * Turns a raw Annex-B byte stream, read in arbitrary pieces, into decoded
 * frames. Shared by the app's viewfinder and the OBS page the webcam server
 * hands out, so it imports nothing from Vue or Nuxt.
 */
import { buildCodecString, detectCodec, drainAccessUnits, splitNalUnits } from "./annexB";
import type { NalCodec } from "./annexB";

export interface Chunk {
  type: "key" | "delta";
  timestamp: number;
  data: Uint8Array;
}

export interface DecoderConfig {
  codec: string;
  optimizeForLatency: boolean;
}

export interface DecoderHooks {
  output(frame: VideoFrame): void;
  error(cause: Error): void;
}

/** The part of `VideoDecoder` this uses, so tests can stand in for it. */
export interface Decoder {
  readonly state: string;
  configure(config: DecoderConfig): void;
  decode(chunk: Chunk): void;
  close(): void;
}

export type CreateDecoder = (hooks: DecoderHooks) => Decoder;

export interface AnnexBDecoderEvents {
  frame(frame: VideoFrame): void;
  note?(message: string): void;
  /** The platform can't decode this stream; no further bytes are taken. */
  fatal?(message: string): void;
}

export const createVideoDecoder: CreateDecoder = (hooks) => {
  const decoder = new VideoDecoder(hooks);
  return {
    get state() {
      return decoder.state;
    },
    configure: (config) => decoder.configure(config),
    decode: (chunk) => decoder.decode(new EncodedVideoChunk(chunk)),
    close: () => decoder.close(),
  };
};

/** ~30 fps, in microseconds. */
const FRAME_DURATION = 33333;
const START_CODE = [0, 0, 0, 1];

export class AnnexBDecoder {
  private decoder: Decoder | null = null;
  /** Bytes that arrived mid-NAL and must be prepended to the next read. */
  private carry = new Uint8Array(0);
  /** Complete NAL units not yet proven to form a finished picture. */
  private pendingUnits: Uint8Array[] = [];
  private codec: NalCodec | null = null;
  private seenKeyframe = false;
  private timestamp = 0;
  private failed = false;

  constructor(
    private readonly events: AnnexBDecoderEvents,
    private readonly create: CreateDecoder = createVideoDecoder,
  ) {}

  /** Feeds one read. False once the stream can't be decoded at all. */
  push(bytes: Uint8Array): boolean {
    if (this.failed) return false;

    const merged = new Uint8Array(this.carry.length + bytes.length);
    merged.set(this.carry);
    merged.set(bytes, this.carry.length);

    const units = splitNalUnits(merged);
    if (units.length === 0) {
      this.carry = merged;
      return true;
    }
    // The last unit may be cut mid-NAL; hold its bytes back for the next read.
    const tail = units.at(-1)!;
    this.carry = new Uint8Array(START_CODE.length + tail.length);
    this.carry.set(START_CODE);
    this.carry.set(tail, START_CODE.length);
    // Copy, so these views do not pin the whole merged buffer in memory
    for (const unit of units.slice(0, -1)) this.pendingUnits.push(unit.slice());
    if (this.pendingUnits.length === 0) return true;

    this.codec ??= detectCodec(this.pendingUnits);
    const { codec } = this;
    if (!codec) return true;

    if (!this.decoder && !this.configure(codec)) return !this.failed;

    const { access, pending } = drainAccessUnits(this.pendingUnits, codec);
    this.pendingUnits = pending;

    for (const unit of access) {
      // An error may have reset the decoder mid-batch; the next keyframe
      // configures a fresh one.
      if (this.decoder?.state !== "configured") break;
      // Feeding delta frames before the first keyframe guarantees a failure
      if (!unit.key && !this.seenKeyframe) continue;
      if (unit.key) this.seenKeyframe = true;
      this.decoder.decode({
        type: unit.key ? "key" : "delta",
        timestamp: this.timestamp,
        data: unit.data,
      });
      this.timestamp += FRAME_DURATION;
    }
    return true;
  }

  /** Drops everything, as for a new connection. */
  reset() {
    this.resync();
    this.carry = new Uint8Array(0);
    this.timestamp = 0;
    this.failed = false;
  }

  /** Builds a decoder from the pending parameter sets. False until it can. */
  private configure(codec: NalCodec): boolean {
    const codecString = buildCodecString(this.pendingUnits, codec);
    if (!codecString) return false;
    this.events.note?.(`Detected ${codec}, codec string ${codecString}.`);
    const decoder = this.create({
      output: (frame) => this.events.frame(frame),
      error: (cause) => {
        // A garbled or dropped frame: drop only the decode pipeline and keep
        // reading, so the next keyframe brings the picture back.
        this.events.note?.(`Decoder error, resyncing at next keyframe: ${cause.message}`);
        this.resync();
      },
    });
    try {
      decoder.configure({ codec: codecString, optimizeForLatency: true });
    } catch (cause) {
      decoder.close();
      this.failed = true;
      this.events.fatal?.(
        `VideoDecoder rejected "${codecString}": ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
      return false;
    }
    this.decoder = decoder;
    return true;
  }

  /**
   * Tears down only the decode pipeline. `carry` and `timestamp` stay, so the
   * stream keeps its place and timestamps never jump backwards.
   */
  private resync() {
    try {
      this.decoder?.close();
    } catch {
      // Already closed
    }
    this.decoder = null;
    this.pendingUnits = [];
    this.codec = null;
    this.seenKeyframe = false;
  }
}
