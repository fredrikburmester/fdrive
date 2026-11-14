import { z } from "zod";

/**
 * Why an identity's index-backed features are unavailable, or "ok" when
 * they are available; reported by `GET /api/v1/search/status`. See
 * `docs/SCOPING.md`. The scope resolver reports `provider_mismatch` (the
 * login's storage is gone or disabled), `invalid_configuration` (its
 * username cannot name a folder) and `no_roots` (its storage is not under an
 * indexed root); MCP tools say `no_connection` when the login itself is gone.
 */
export const IdentityScopeReason = z.enum([
  "ok",
  "no_connection",
  "provider_mismatch",
  "invalid_configuration",
  "no_roots",
]);
export type IdentityScopeReason = z.infer<typeof IdentityScopeReason>;
