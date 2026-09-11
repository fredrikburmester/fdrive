const TOO_LARGE = "This file is too large to preview. Download it instead.";

/**
 * Reads `response`'s body into a Blob, refusing before the first byte when
 * `Content-Length` exceeds `limit` and cancelling mid-stream if the body grows
 * past it anyway, so a preview never buffers more than `limit` bytes.
 */
export async function boundedBody(
  response: Response,
  limit: number,
  signal: AbortSignal,
  tooLarge: string = TOO_LARGE,
): Promise<Blob> {
  const size = Number(response.headers.get("content-length"));
  if (size > limit) {
    await response.body?.cancel();
    throw new Error(tooLarge);
  }
  if (!response.body) return new Blob();
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error(tooLarge);
      }
      chunks.push(new Uint8Array(chunk.value));
    }
    return new Blob(chunks);
  } finally {
    signal.removeEventListener("abort", abort);
    if (signal.aborted) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
