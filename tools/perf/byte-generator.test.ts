import { describe, expect, it } from "vitest";
import {
  createByteGeneratorState,
  createDeterministicByteStream,
  fillPseudoRandomBytes,
  nextUint32,
} from "./byte-generator.js";

describe("nextUint32", () => {
  it("is deterministic for the same state", () => {
    const a = nextUint32(1234);
    const b = nextUint32(1234);
    expect(a).toEqual(b);
  });

  it("advances the state to something different from the input for a non-zero seed", () => {
    const { nextState } = nextUint32(1);
    expect(nextState).not.toBe(1);
  });

  it("never gets stuck returning the same value forever", () => {
    let state = 42;
    const seen = new Set<number>();
    for (let i = 0; i < 20; i++) {
      const { value, nextState } = nextUint32(state);
      seen.add(value);
      state = nextState;
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("createByteGeneratorState", () => {
  it("remaps a zero seed away from zero", () => {
    const state = createByteGeneratorState(0);
    expect(state.word).not.toBe(0);
  });

  it("starts with no pending bytes", () => {
    expect(createByteGeneratorState(7).pending).toEqual([]);
  });
});

describe("fillPseudoRandomBytes", () => {
  it("returns a buffer of exactly the requested length", () => {
    const { bytes } = fillPseudoRandomBytes(37, 7);
    expect(bytes.length).toBe(37);
  });

  it("is deterministic for the same length and seed", () => {
    const a = fillPseudoRandomBytes(100, 555);
    const b = fillPseudoRandomBytes(100, 555);
    expect(Array.from(a.bytes)).toEqual(Array.from(b.bytes));
    expect(a.nextState).toEqual(b.nextState);
  });

  it("produces different bytes for different seeds", () => {
    const a = fillPseudoRandomBytes(64, 1);
    const b = fillPseudoRandomBytes(64, 2);
    expect(Array.from(a.bytes)).not.toEqual(Array.from(b.bytes));
  });

  it("never stalls on a zero seed", () => {
    const { bytes } = fillPseudoRandomBytes(16, 0);
    expect(bytes.some((byte) => byte !== 0)).toBe(true);
  });

  it("handles a zero length request", () => {
    const { bytes, nextState } = fillPseudoRandomBytes(0, 99);
    expect(bytes.length).toBe(0);
    expect(nextState).toEqual(createByteGeneratorState(99));
  });

  it("accepts a plain numeric seed or a resumed ByteGeneratorState interchangeably", () => {
    const fromNumber = fillPseudoRandomBytes(10, 42);
    const fromState = fillPseudoRandomBytes(10, createByteGeneratorState(42));
    expect(Array.from(fromNumber.bytes)).toEqual(Array.from(fromState.bytes));
  });

  it("chains: one call of length a+b equals two chained calls of length a then b", () => {
    const seed = 2024;
    const whole = fillPseudoRandomBytes(11, seed);
    const first = fillPseudoRandomBytes(4, seed);
    const second = fillPseudoRandomBytes(7, first.nextState);
    const chained = new Uint8Array([...first.bytes, ...second.bytes]);
    expect(Array.from(whole.bytes)).toEqual(Array.from(chained));
  });

  it("chains correctly even when the split falls inside a 4-byte word", () => {
    const seed = 13;
    const whole = fillPseudoRandomBytes(10, seed);
    const first = fillPseudoRandomBytes(3, seed);
    const second = fillPseudoRandomBytes(7, first.nextState);
    const chained = new Uint8Array([...first.bytes, ...second.bytes]);
    expect(Array.from(whole.bytes)).toEqual(Array.from(chained));
  });

  it("chains correctly across many small, unaligned splits", () => {
    const seed = 987654321;
    const whole = fillPseudoRandomBytes(37, seed);

    const splits = [1, 5, 2, 9, 3, 6, 11];
    let state: Parameters<typeof fillPseudoRandomBytes>[1] = seed;
    const chunks: Uint8Array[] = [];
    for (const size of splits) {
      const { bytes, nextState } = fillPseudoRandomBytes(size, state);
      chunks.push(bytes);
      state = nextState;
    }
    const chained = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      chained.set(chunk, offset);
      offset += chunk.length;
    }

    expect(Array.from(whole.bytes)).toEqual(Array.from(chained));
  });
});

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

describe("createDeterministicByteStream", () => {
  it("emits exactly totalBytes bytes", async () => {
    const stream = createDeterministicByteStream(53, 10, 1);
    const bytes = await readAll(stream);
    expect(bytes.length).toBe(53);
  });

  it("is deterministic across two independent streams", async () => {
    const a = await readAll(createDeterministicByteStream(53, 10, 1));
    const b = await readAll(createDeterministicByteStream(53, 10, 1));
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("matches a single fillPseudoRandomBytes call for the same total and seed", async () => {
    const streamed = await readAll(createDeterministicByteStream(41, 6, 77));
    const whole = fillPseudoRandomBytes(41, 77);
    expect(Array.from(streamed)).toEqual(Array.from(whole.bytes));
  });

  it("produces the same bytes for a different chunk size, same seed and total", async () => {
    // The generator's state (including any partially used word) carries
    // over between pull() calls, so the byte sequence does not depend on
    // how it happens to be chunked.
    const a = await readAll(createDeterministicByteStream(41, 6, 77));
    const b = await readAll(createDeterministicByteStream(41, 20, 77));
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("handles totalBytes of zero", async () => {
    const bytes = await readAll(createDeterministicByteStream(0, 10, 1));
    expect(bytes.length).toBe(0);
  });
});
