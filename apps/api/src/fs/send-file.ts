import { fileSlice, type OpenFile } from "@fdrive/core";

/** How much of the file a response sends. */
export interface SentSlice {
  /** Whether it is a byte range (206) rather than the whole file. */
  readonly partial: boolean;
  /** The bytes it sends. */
  readonly length: number;
}

export interface SendFileOptions {
  /**
   * Runs once the request is known to get bytes, before any is read; a
   * refusal closes the file and rejects with it.
   */
  readonly admit?: () => Promise<void>;
  /** What the response sends of the bytes; the bytes themselves by default. */
  readonly body?: (
    bytes: ReadableStream<Uint8Array>,
    sent: SentSlice,
  ) => ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>;
}

/**
 * The answer to a GET or HEAD of `file`, which it takes over: the slice the
 * request's `Range` and `If-Range` ask for (`fileSlice`) with `headers` and
 * the slice's own, or a 416 naming the file's size. Every route that serves
 * a file's bytes (`/fs/download`, a share link's download, Office's
 * GetFile) answers through this. A 416, a HEAD or a refused `admit` closes
 * the file; otherwise the response's stream closes it once it is sent or the
 * client goes away.
 */
export async function sendFile(
  request: Request,
  file: OpenFile,
  headers: Readonly<Record<string, string>>,
  options: SendFileOptions = {},
): Promise<Response> {
  const slice = fileSlice(file, request.headers.get("range"), request.headers.get("if-range"));
  if (slice.status === 416) {
    await file.close();
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${file.size}` },
    });
  }
  const length = slice.end - slice.start + 1;
  const sent = new Headers({
    ...headers,
    "Content-Length": String(length),
    "Last-Modified": file.modifiedAt.toUTCString(),
    "Accept-Ranges": "bytes",
  });
  if (slice.status === 206) {
    sent.set("Content-Range", `bytes ${slice.start}-${slice.end}/${file.size}`);
  }
  if (request.method === "HEAD") {
    await file.close();
    return new Response(null, { status: slice.status, headers: sent });
  }
  try {
    await options.admit?.();
  } catch (error) {
    await file.close();
    throw error;
  }
  const bytes = file.stream(slice.start, slice.end);
  const body =
    options.body === undefined
      ? bytes
      : await options.body(bytes, { partial: slice.status === 206, length });
  return new Response(body, { status: slice.status, headers: sent });
}
