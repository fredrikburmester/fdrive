/**
 * A small, dependency-free deterministic pseudo random byte generator used
 * to build the perf harness's seeded fixtures (in particular the 512 MiB
 * file under `/big/large.bin`) without ever holding the whole payload in
 * memory. Xorshift32 is not cryptographically secure, which is fine here:
 * the only requirement is "the same seed always produces the same bytes",
 * independent of how the output happens to be chunked.
 */

/** A zero word would stay zero forever under xorshift32, so it is remapped to this instead. */
const FALLBACK_SEED = 0x9e3779b9;

/**
 * Advances a 32-bit xorshift state by one step, returning the new state
 * (also used as the emitted word). Pure: the same `state` always produces
 * the same `{ value, nextState }`.
 */
export function nextUint32(state: number): { value: number; nextState: number } {
  let x = state | 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  const next = x | 0;
  return { value: next >>> 0, nextState: next };
}

/**
 * The generator's resumable state: the xorshift word plus any bytes already
 * drawn from the current word but not yet emitted (0 to 3 of them, in
 * emission order). Carrying `pending` is what lets output be split at any
 * byte boundary, not just every 4 bytes, without changing the resulting
 * byte sequence.
 */
export interface ByteGeneratorState {
  readonly word: number;
  readonly pending: readonly number[];
}

/** Builds a fresh generator state from a plain numeric seed. */
export function createByteGeneratorState(seed: number): ByteGeneratorState {
  return { word: seed === 0 ? FALLBACK_SEED : seed | 0, pending: [] };
}

function bytesOfWord(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

/**
 * Fills a fresh `length`-byte buffer, drawing from `state` (a plain numeric
 * seed for a fresh sequence, or a `ByteGeneratorState` to resume one),
 * returning the buffer plus the state to resume from for the next chunk.
 * Pure and deterministic: the same `length` and `state` always produce the
 * same output, and splitting one call into any sequence of chained calls
 * (each passing the previous call's `nextState` as its own `state`)
 * produces exactly the same concatenated bytes as one call for the combined
 * length, regardless of where the splits fall.
 */
export function fillPseudoRandomBytes(
  length: number,
  state: number | ByteGeneratorState,
): { bytes: Uint8Array; nextState: ByteGeneratorState } {
  let word: number;
  let pending: number[];
  if (typeof state === "number") {
    word = state === 0 ? FALLBACK_SEED : state | 0;
    pending = [];
  } else {
    word = state.word;
    pending = [...state.pending];
  }

  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    if (pending.length === 0) {
      const next = nextUint32(word);
      word = next.nextState;
      pending = bytesOfWord(next.value);
    }
    // `pending` was just refilled to 4 entries above whenever it was empty,
    // so `shift()` always has something to return here.
    bytes[i] = pending.shift() as number;
  }

  return { bytes, nextState: { word, pending } };
}

/**
 * Builds a `ReadableStream<Uint8Array>` of exactly `totalBytes` deterministic
 * pseudo random bytes, generated `chunkSize` bytes at a time so the whole
 * payload is never resident in memory at once. The resulting bytes are the
 * same regardless of `chunkSize`, since the generator's state (including
 * any partially used word) carries over between chunks.
 */
export function createDeterministicByteStream(
  totalBytes: number,
  chunkSize: number,
  seed: number,
): ReadableStream<Uint8Array> {
  let remaining = totalBytes;
  let state: ByteGeneratorState = createByteGeneratorState(seed);
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (remaining <= 0) {
        controller.close();
        return;
      }
      const size = Math.min(chunkSize, remaining);
      const { bytes, nextState } = fillPseudoRandomBytes(size, state);
      state = nextState;
      remaining -= size;
      controller.enqueue(bytes);
    },
  });
}
