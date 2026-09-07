/** Drain completed payloads without retaining them. Truncation is a failed observation. */
export async function drain(response: Response, expectedBytes?: number): Promise<number> {
  if (!response.ok) {
    await response.body?.cancel();
    throw Error(`Request failed: ${response.status}`);
  }
  let bytes = 0;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
  }
  if (expectedBytes !== undefined && bytes !== expectedBytes)
    throw Error(`Incomplete payload: ${bytes}/${expectedBytes}`);
  return bytes;
}
export function alternatingPairs(
  count: number,
): Array<readonly ["direct" | "api", "direct" | "api"]> {
  return Array.from({ length: count }, (_, i) =>
    i % 2 === 0 ? ["direct", "api"] : ["api", "direct"],
  );
}
