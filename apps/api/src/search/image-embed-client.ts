import { z } from "zod";
import {
  callSidecar,
  type SidecarRequestDeps,
  type SidecarResult,
} from "../system/sidecar-client.js";

/** 5 seconds, per `docs/workflow/P7-IMAGE-SEARCH-API.md` decision 6 for the image-embed query call. */
export const DEFAULT_IMAGE_EMBED_TIMEOUT_MS = 5000;

/** The sidecar rejects a `q` longer than this; truncated before sending rather than left to error. */
export const MAX_IMAGE_EMBED_QUERY_LENGTH = 512;

/**
 * The image-embed sidecar's own reported health, mirrored from its `GET
 * /health` (`services/image-embed/README.md`). `dim` is `null` while
 * `status` is `"loading"`; the sidecar never answers 503 for `/health`
 * itself, only for embed requests made before the model is resident.
 */
export interface ImageEmbedHealthInfo {
  readonly status: "ok" | "loading";
  readonly model: string;
  readonly dim: number | null;
  readonly device: "cpu" | "cuda";
}

const ImageEmbedHealthRaw = z.object({
  status: z.enum(["ok", "loading"]),
  model: z.string(),
  dim: z.number().int().nullable(),
  device: z.enum(["cpu", "cuda"]),
});

/**
 * One `POST /embed/text` response, tolerant of extra fields. `embeddings` is
 * one L2-normalized vector per input, in request order.
 */
const EmbedTextRaw = z.object({
  model: z.string(),
  dim: z.number().int(),
  embeddings: z.array(z.array(z.number())),
});

/** A resolved query embedding plus the model id that produced it. */
export interface ImageEmbedQueryResult {
  readonly vector: readonly number[];
  readonly model: string;
}

export interface ImageEmbedClientDeps extends SidecarRequestDeps {
  readonly baseUrl: string;
}

/**
 * A typed client for the image-embed sidecar's internal HTTP API
 * (`services/image-embed`). `embedText` never throws: a network failure,
 * timeout, non-2xx response, or a response with zero embeddings all resolve
 * `null`, so image-content search degrades to "no image hits" rather than
 * failing the whole search request.
 */
export interface ImageEmbedClient {
  health(): Promise<SidecarResult<ImageEmbedHealthInfo>>;
  embedText(query: string): Promise<ImageEmbedQueryResult | null>;
}

/** Builds an `ImageEmbedClient` calling `deps.baseUrl` with `deps.fetch`. */
export function createImageEmbedClient(deps: ImageEmbedClientDeps): ImageEmbedClient {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_IMAGE_EMBED_TIMEOUT_MS;

  return {
    async health() {
      const result = await callSidecar(
        deps.baseUrl,
        "/health",
        ImageEmbedHealthRaw,
        {},
        { fetch: deps.fetch, timeoutMs },
      );
      return result;
    },

    async embedText(query: string) {
      const truncated = query.slice(0, MAX_IMAGE_EMBED_QUERY_LENGTH);
      const result = await callSidecar(
        deps.baseUrl,
        "/embed/text",
        EmbedTextRaw,
        { method: "POST", jsonBody: { inputs: [truncated] } },
        { fetch: deps.fetch, timeoutMs },
      );
      if (!result.ok) {
        return null;
      }
      const vector = result.data.embeddings[0];
      if (vector === undefined) {
        return null;
      }
      return { vector, model: result.data.model };
    },
  };
}
