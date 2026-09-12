import { createHash } from "node:crypto";
import { baseName, extensionOf, mimeFromExtension } from "@fdrive/core";
import type { Principal } from "../auth/principal.ts";
import { ordinaryPath, requireExplicitAccess } from "./access.ts";
import { pageText } from "./format.ts";
import type { McpToolDeps, ReadFileTextArgs } from "./handlers.ts";
import { fileUrl, folderUrl } from "./urls.ts";

export const MAX_FILE_BYTES = 4 * 1024 * 1024;

export async function boundedBytes(
  body: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Buffer> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return Buffer.concat(chunks, size);
      size += next.value.byteLength;
      if (size > limit) throw new Error(`file exceeds the ${limit} byte limit`);
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function readStoredFile(deps: McpToolDeps, principal: Principal, rawPath: string) {
  requireExplicitAccess(principal);
  const path = ordinaryPath(deps, principal, rawPath);
  const stat = await principal.storage.statFile(path);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`file exceeds the ${MAX_FILE_BYTES} byte limit`);
  const result = await principal.storage.download(path, { signal: AbortSignal.timeout(30_000) });
  if (result.contentLength !== null && result.contentLength > MAX_FILE_BYTES) {
    await result.body.cancel();
    throw new Error(`file exceeds the ${MAX_FILE_BYTES} byte limit`);
  }
  const bytes = await boundedBytes(result.body, MAX_FILE_BYTES);
  return {
    path,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    mime: mimeFromExtension(extensionOf(baseName(path))) ?? "application/octet-stream",
    url: fileUrl(await deps.publicUrl(), path),
  };
}

export function decodeText(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\0") ? null : text;
  } catch {
    return null;
  }
}

export async function readFileTextDirect(
  deps: McpToolDeps,
  principal: Principal,
  args: ReadFileTextArgs,
) {
  const file = await readStoredFile(deps, principal, args.path);
  const document = /\.(pdf|docx?|xlsx?|pptx?|od[tpfs]|rtf|png|jpe?g|webp|tiff?|heic|heif)$/i.test(
    file.path,
  );
  let text = document ? null : decodeText(file.bytes);
  let status = "read";
  if (text === null) {
    if (deps.indexerClient?.extractContent === undefined)
      throw new Error(
        "Document extraction is unavailable; read_file can return the original bytes.",
      );
    const extracted = await deps.indexerClient.extractContent({
      name: baseName(file.path),
      bytes: file.bytes,
    });
    if (extracted === null)
      throw new Error(
        "Document extraction is unavailable; try again when the indexer is reachable.",
      );
    text = extracted.text;
    status = extracted.status;
  }
  const page = pageText(text, args.offset ?? 0, args.max_chars ?? 8000);
  return {
    path: file.path,
    url: file.url,
    sha256: file.sha256,
    status,
    total_chars: page.totalChars,
    offset: args.offset ?? 0,
    text: page.slice,
    has_more: page.hasMore,
  };
}

export async function readFile(deps: McpToolDeps, principal: Principal, path: string) {
  const file = await readStoredFile(deps, principal, path);
  return {
    path: file.path,
    url: file.url,
    mime: file.mime,
    size_bytes: file.bytes.length,
    sha256: file.sha256,
    encoding: "base64",
    data: file.bytes.toString("base64"),
  };
}

export async function liveFileInfo(deps: McpToolDeps, principal: Principal, rawPath: string) {
  const path = ordinaryPath(deps, principal, rawPath);
  const stat = await principal.storage.stat(path);
  const publicUrl = await deps.publicUrl();
  return {
    path,
    name: baseName(path),
    kind: stat.kind,
    size_bytes: stat.size,
    identical_copies: [] as string[],
    partial: true,
    modified: stat.modifiedAt?.toISOString() ?? null,
    mime: stat.contentType,
    url: stat.kind === "dir" ? folderUrl(publicUrl, path) : fileUrl(publicUrl, path),
  };
}
