import { ApiError } from "@fdrive/contracts";
import { previewKindFor } from "@/lib/preview/kind";

export const PUBLIC_TEXT_LIMIT = 1024 * 1024;
export const PUBLIC_BLOB_LIMIT = 32 * 1024 * 1024;
export type PublicPreviewKind =
  | "image"
  | "audio"
  | "video"
  | "pdf"
  | "text"
  | "code"
  | "markdown"
  | "none";

/** Public Office and active SVG content are always download-only. */
export function publicPreviewKind(name: string, size = 0): PublicPreviewKind {
  const ext = name.includes(".") ? `.${name.split(".").at(-1)?.toLowerCase()}` : "";
  if (ext === ".svg" || ext === ".svgz") return "none";
  const kind = previewKindFor({ ext, mime: null, size: 0 });
  if (kind === "office" || kind === "archive") return "none";
  if ((kind === "text" || kind === "code" || kind === "markdown") && size > PUBLIC_TEXT_LIMIT)
    return "none";
  if (kind === "pdf" && size > PUBLIC_BLOB_LIMIT) return "none";
  return kind;
}

async function boundedBody(response: Response, limit: number, signal: AbortSignal): Promise<Blob> {
  const size = Number(response.headers.get("content-length"));
  if (size > limit) {
    await response.body?.cancel();
    throw new Error("This file is too large to preview. Download it instead.");
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
        throw new Error("This file is too large to preview. Download it instead.");
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

export async function fetchPublicPreview(
  url: string,
  kind: "pdf" | "text" | "code" | "markdown",
  signal: AbortSignal,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<Blob | string> {
  const response = await fetchImpl(url, { signal, credentials: "same-origin", cache: "no-store" });
  if (!response.ok) {
    let message = "Could not open this file. Check the share password or try downloading it.";
    try {
      const error = ApiError.safeParse(
        JSON.parse(await (await boundedBody(response, 8192, signal)).text()),
      );
      if (error.success) message = error.data.error.message;
    } catch {
      signal.throwIfAborted();
    }
    throw new Error(message);
  }
  const body = await boundedBody(
    response,
    kind === "pdf" ? PUBLIC_BLOB_LIMIT : PUBLIC_TEXT_LIMIT,
    signal,
  );
  if (kind === "pdf") {
    if ((await body.slice(0, 5).text()) !== "%PDF-")
      throw new Error("This file cannot be previewed as a PDF. Download it instead.");
    signal.throwIfAborted();
    return new Blob([body], { type: "application/pdf" });
  }
  const text = await body.text();
  signal.throwIfAborted();
  return text;
}
