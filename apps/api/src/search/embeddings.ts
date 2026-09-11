/** Timeout for the TEI query call. */
export const DEFAULT_EMBED_TIMEOUT_MS = 5000;

/**
 * Resolves a query embedding, or `null` when the embedding service is
 * unavailable or misconfigured, so search degrades to keyword-only rather
 * than failing outright.
 */
export interface EmbedClient {
  embed(query: string): Promise<number[] | null>;
}

export interface CreateEmbedClientOptions {
  /** The TEI base URL, e.g. `http://embed:80`. `/embed` is appended. */
  readonly baseUrl: string;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

/**
 * Validates and extracts the first embedding vector from a parsed TEI
 * `/embed` response body, which is a JSON array of vectors (one per input),
 * each a flat array of numbers. Pure, so it is unit tested without a
 * network call. Returns `null` for any shape that is not exactly that.
 */
export function parseEmbedResponse(data: unknown): number[] | null {
  if (!Array.isArray(data) || data.length === 0) {
    return null;
  }
  const first = data[0];
  if (!Array.isArray(first) || first.length === 0) {
    return null;
  }
  if (!first.every((value) => typeof value === "number" && Number.isFinite(value))) {
    return null;
  }
  return first as number[];
}

/**
 * Builds a client for the TEI embeddings service: `POST /embed` with
 * `{ inputs: ["query: " + q], normalize: true, truncate: true }`, a 5
 * second timeout, and `null` on any failure (non-2xx response, a timeout, a
 * network error, or an unexpected body shape) so callers can fall back to
 * keyword-only search rather than fail the whole request.
 */
export function createEmbedClient(options: CreateEmbedClientOptions): EmbedClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS;
  const url = `${options.baseUrl.replace(/\/+$/, "")}/embed`;

  return {
    async embed(query: string): Promise<number[] | null> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ inputs: [`query: ${query}`], normalize: true, truncate: true }),
          signal: controller.signal,
        });
        if (!response.ok) {
          return null;
        }
        const data: unknown = await response.json();
        return parseEmbedResponse(data);
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
