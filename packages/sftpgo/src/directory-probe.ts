import { SftpgoError } from "./errors.js";

export const DEFAULT_PROBE_MAX_BYTES = 64 * 1024;

function toProbeError(error: unknown): SftpgoError {
  if (error instanceof SftpgoError) {
    return error;
  }
  const message = error instanceof Error ? error.message : "Directory probe failed";
  return new SftpgoError(message, "server", null, null);
}

/**
 * Validates that a directory stream starts with either an empty JSON array
 * or a valid first JSON object entry, then cancels the remainder of the stream.
 */
export async function probeDirectoryStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes = DEFAULT_PROBE_MAX_BYTES,
): Promise<void> {
  if (maxBytes <= 0) {
    throw new SftpgoError("Directory probe exceeded maximum prefix limit", "server", null, null);
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let totalBytes = 0;
  let text = "";
  let inArray = false;
  let inObject = false;
  let objectStartIndex = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let completed = false;

  try {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        const remainingBudget = maxBytes - totalBytes;
        const slice =
          value.byteLength > remainingBudget ? value.subarray(0, remainingBudget) : value;
        totalBytes += slice.byteLength;

        const chunkText = decoder.decode(slice, { stream: true });
        const startIndex = text.length;
        text += chunkText;

        for (let i = startIndex; i < text.length; i++) {
          const char = text[i];

          if (!inArray) {
            if (char === " " || char === "\t" || char === "\r" || char === "\n") {
              continue;
            }
            if (char === "[") {
              inArray = true;
              continue;
            }
            throw new SftpgoError("Invalid directory stream: expected array", "server", null, null);
          }

          if (!inObject) {
            if (char === " " || char === "\t" || char === "\r" || char === "\n") {
              continue;
            }
            if (char === "]") {
              completed = true;
              break;
            }
            if (char === "{") {
              inObject = true;
              objectStartIndex = i;
              depth = 1;
              continue;
            }
            throw new SftpgoError(
              "Invalid directory stream: expected entry object or end of array",
              "server",
              null,
              null,
            );
          }

          // Inside the first object
          if (inString) {
            if (escaped) {
              escaped = false;
            } else if (char === "\\") {
              escaped = true;
            } else if (char === '"') {
              inString = false;
            }
            continue;
          }

          if (char === '"') {
            inString = true;
            continue;
          }

          if (char === "{") {
            depth += 1;
          } else if (char === "}") {
            depth -= 1;
            if (depth === 0) {
              const objectJson = text.slice(objectStartIndex, i + 1);
              try {
                JSON.parse(objectJson);
                completed = true;
                break;
              } catch {
                throw new SftpgoError(
                  "Invalid directory stream: first entry is malformed",
                  "server",
                  null,
                  null,
                );
              }
            }
          }
        }

        if (completed) {
          break;
        }

        if (totalBytes >= maxBytes) {
          throw new SftpgoError(
            "Directory probe exceeded maximum prefix limit",
            "server",
            null,
            null,
          );
        }
      }

      if (!completed) {
        throw new SftpgoError("Directory stream ended unexpectedly", "server", null, null);
      }
    } finally {
      await reader.cancel();
    }
  } catch (error) {
    throw toProbeError(error);
  } finally {
    reader.releaseLock();
  }
}
