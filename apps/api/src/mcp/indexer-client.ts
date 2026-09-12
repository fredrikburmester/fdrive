/** One extracted document, as returned by the indexer's internal `POST /extract`. */
export interface ExtractResult {
  readonly text: string;
  readonly status: string;
}

export interface IndexerExtractClient {
  /**
   * Live text extraction for one root-relative path. `null` when the
   * indexer responds with anything other than 2xx (unreachable, path not
   * found, unsupported format).
   */
  extract(input: { root: string; path: string }): Promise<ExtractResult | null>;
  /** Bounded bytes already authorized and read through the caller's provider. */
  extractContent?(input: { name: string; bytes: Uint8Array }): Promise<ExtractResult | null>;
}

export interface CreateIndexerExtractClientDeps {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
}

/** True when `value` is a plain object shaped like an `ExtractResult`. */
function isExtractResultShaped(value: unknown): value is { text?: unknown; status?: unknown } {
  return typeof value === "object" && value !== null;
}

/**
 * Builds a client for the indexer's internal `POST /extract` endpoint (only
 * reachable inside the compose network), used by the MCP `read_file_text`
 * tool for live text extraction.
 */
export function createIndexerExtractClient(
  deps: CreateIndexerExtractClientDeps,
): IndexerExtractClient {
  return {
    async extractContent(input) {
      try {
        const response = await deps.fetch(
          `${deps.baseUrl}/extract-content?name=${encodeURIComponent(input.name)}`,
          {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body: new Uint8Array(input.bytes),
            signal: AbortSignal.timeout(30_000),
          },
        );
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          return null;
        }
        const body: unknown = await response.json();
        if (!isExtractResultShaped(body) || typeof body.status !== "string") return null;
        return { text: typeof body.text === "string" ? body.text : "", status: body.status };
      } catch {
        return null;
      }
    },
    async extract(input) {
      let response: Response;
      try {
        response = await deps.fetch(`${deps.baseUrl}/extract`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        return null;
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return null;
      }

      if (!isExtractResultShaped(body)) {
        return null;
      }

      return {
        text: typeof body.text === "string" ? body.text : "",
        status: typeof body.status === "string" ? body.status : "unknown",
      };
    },
  };
}
