import { describe, expect, it } from "vitest";
import { AnnexBDecoder } from "~/utils/annexBDecoder";
import type { Chunk, CreateDecoder, DecoderConfig, DecoderHooks } from "~/utils/annexBDecoder";

function annexB(...payloads: number[][]): Uint8Array {
  const out: number[] = [];
  for (const payload of payloads) out.push(0, 0, 0, 1, ...payload);
  return new Uint8Array(out);
}

const SPS = [0x42, 0x01, 0x01, 0x01, 0x60, 0, 0, 0, 0xb0, 0, 0, 0, 0, 0, 0x5d];
const VPS = [0x40, 0x01, 0x0c];
const PPS = [0x44, 0x01, 0xc0];
const IDR = [0x26, 0x01, 0x80];
const TRAIL = [0x02, 0x01, 0x80];

class FakeDecoder {
  state = "unconfigured";
  configs: DecoderConfig[] = [];
  chunks: Chunk[] = [];
  closed = false;
  rejectConfig = false;
  constructor(readonly hooks: DecoderHooks) {}
  configure(config: DecoderConfig) {
    if (this.rejectConfig) throw new Error("unsupported");
    this.configs.push(config);
    this.state = "configured";
  }
  decode(chunk: Chunk) {
    this.chunks.push(chunk);
  }
  close() {
    this.closed = true;
    this.state = "closed";
  }
}

function setup(options: { rejectConfig?: boolean } = {}) {
  const decoders: FakeDecoder[] = [];
  const notes: string[] = [];
  const fatal: string[] = [];
  const create: CreateDecoder = (hooks) => {
    const decoder = new FakeDecoder(hooks);
    decoder.rejectConfig = options.rejectConfig ?? false;
    decoders.push(decoder);
    return decoder;
  };
  const player = new AnnexBDecoder(
    { frame: () => {}, note: (m) => notes.push(m), fatal: (m) => fatal.push(m) },
    create,
  );
  return { player, decoders, notes, fatal };
}

describe("AnnexBDecoder", () => {
  it("configures from the parameter sets and decodes the keyframe once the next picture starts", () => {
    const { player, decoders } = setup();
    expect(player.push(annexB(VPS, SPS, PPS, IDR, TRAIL, TRAIL, TRAIL))).toBe(true);
    expect(decoders).toHaveLength(1);
    expect(decoders[0]!.configs).toEqual([{ codec: "hvc1.1.6.L93.B0", optimizeForLatency: true }]);
    const types = decoders[0]!.chunks.map((c) => c.type);
    expect(types).toEqual(["key", "delta"]);
    expect(decoders[0]!.chunks[0]!.data.slice(0, 7)).toEqual(new Uint8Array([0, 0, 0, 1, ...VPS]));
  });

  it("joins a NAL unit split across reads", () => {
    const { player, decoders } = setup();
    const bytes = annexB(VPS, SPS, PPS, IDR, TRAIL, TRAIL, TRAIL);
    for (let i = 0; i < bytes.length; i += 5) player.push(bytes.subarray(i, i + 5));
    expect(decoders[0]!.chunks.map((c) => c.type)).toEqual(["key", "delta"]);
  });

  it("skips pictures until the first keyframe", () => {
    const { player, decoders } = setup();
    player.push(annexB(VPS, SPS, PPS, TRAIL, TRAIL, IDR, TRAIL, TRAIL));
    expect(decoders[0]!.chunks.map((c) => c.type)).toEqual(["key"]);
  });

  it("gives each picture a later timestamp", () => {
    const { player, decoders } = setup();
    player.push(annexB(VPS, SPS, PPS, IDR, TRAIL, TRAIL, TRAIL, TRAIL));
    const stamps = decoders[0]!.chunks.map((c) => c.timestamp);
    expect(stamps).toEqual([0, 33333, 66666]);
  });

  it("recovers from a decode error with a fresh decoder at the next keyframe", () => {
    const { player, decoders, notes } = setup();
    player.push(annexB(VPS, SPS, PPS, IDR, TRAIL, TRAIL));
    decoders[0]!.hooks.error(new Error("glitch"));
    expect(decoders[0]!.closed).toBe(true);
    expect(notes.some((n) => n.includes("glitch"))).toBe(true);
    player.push(annexB(TRAIL, VPS, SPS, PPS, IDR, TRAIL, TRAIL));
    expect(decoders).toHaveLength(2);
    expect(decoders[1]!.chunks.map((c) => c.type)).toEqual(["key"]);
    expect(decoders[1]!.chunks[0]!.timestamp).toBeGreaterThan(
      decoders[0]!.chunks.at(-1)!.timestamp,
    );
  });

  it("reports a codec the platform rejects and stops taking bytes", () => {
    const { player, fatal } = setup({ rejectConfig: true });
    expect(player.push(annexB(VPS, SPS, PPS, IDR, TRAIL))).toBe(false);
    expect(fatal).toEqual(['VideoDecoder rejected "hvc1.1.6.L93.B0": unsupported']);
    expect(player.push(annexB(TRAIL))).toBe(false);
  });

  it("starts over after reset", () => {
    const { player, decoders } = setup();
    player.push(annexB(VPS, SPS, PPS, IDR, TRAIL));
    player.reset();
    expect(decoders[0]!.closed).toBe(true);
    player.push(annexB(VPS, SPS, PPS, IDR, TRAIL, TRAIL));
    expect(decoders[1]!.chunks[0]).toMatchObject({ type: "key", timestamp: 0 });
  });
});
