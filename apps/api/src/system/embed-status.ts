import type { SemanticStatus } from "@fdrive/contracts";
import { z } from "zod";
import {
  callSidecar,
  DEFAULT_SIDECAR_TIMEOUT_MS,
  joinSidecarUrl,
  type SidecarRequestDeps,
} from "./sidecar-client.js";

/** Tolerant of extra fields; TEI's `/info` response carries many more than these two. */
const EmbedInfoRaw = z.object({
  model_id: z.string(),
  max_input_length: z.number().int(),
});

export interface FetchEmbedStatusDeps extends SidecarRequestDeps {
  /** The TEI base URL (`FDRIVE_EMBED_URL`). `undefined` when semantic search is not configured. */
  readonly baseUrl: string | undefined;
}

/**
 * Whether `GET ${baseUrl}${path}` responds with a 2xx status, ignoring the
 * body entirely (TEI's `/health` is not guaranteed to return JSON). Never
 * throws: a network error, timeout, or non-2xx status all resolve `false`.
 */
async function probeOk(baseUrl: string, path: string, deps: SidecarRequestDeps): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_SIDECAR_TIMEOUT_MS);
  try {
    const response = await deps.fetch(joinSidecarUrl(baseUrl, path), { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reports the TEI embedding server's reachability and model info for the
 * System > Search page. `configured` mirrors whether `FDRIVE_EMBED_URL` is
 * set; `healthy` comes from `GET /health` (status only, body ignored) and
 * the model fields from `GET /info`, both best-effort (a failure just
 * leaves `healthy: false` and the model fields absent, never throws).
 */
export async function fetchEmbedStatus(deps: FetchEmbedStatusDeps): Promise<SemanticStatus> {
  if (deps.baseUrl === undefined) {
    return { configured: false, healthy: false };
  }

  const [healthy, infoResult] = await Promise.all([
    probeOk(deps.baseUrl, "/health", deps),
    callSidecar(deps.baseUrl, "/info", EmbedInfoRaw, {}, deps),
  ]);

  return {
    configured: true,
    healthy,
    ...(infoResult.ok
      ? { model: infoResult.data.model_id, maxInputLength: infoResult.data.max_input_length }
      : {}),
  };
}
