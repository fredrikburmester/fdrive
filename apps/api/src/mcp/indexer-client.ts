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
    async extract(input) {
      let response: Response;
      try {
        response = await deps.fetch(`${deps.baseUrl}/extract`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        });
      } catch {
        return null;
      }

      if (!response.ok) {
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
