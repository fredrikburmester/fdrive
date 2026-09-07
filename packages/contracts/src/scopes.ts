import { z } from "zod";

/**
 * A single root name segment as used in a home template or a scope
 * override, e.g. "sftpgo". Matches `@fdrive/core`'s `parseHomeTemplate`
 * root name pattern: lowercase alphanumerics, "_", and "-", starting with
 * an alphanumeric character.
 */
export const ScopeRootName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/);
export type ScopeRootName = z.infer<typeof ScopeRootName>;

/** True when `char` is a NUL byte or another ASCII control character (0x00-0x1f or 0x7f). */
function isControlChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return code <= 0x1f || code === 0x7f;
}

/**
 * True when `value` is an absolute, canonical POSIX-style path: it starts
 * with "/", contains no backslash or control character, has no empty,
 * ".", or ".." segment, and (other than the root itself) no trailing
 * slash or doubled separator.
 *
 * Percent-encoded sequences such as "%20" are ordinary characters here;
 * this never decodes them, so a directory literally named "%20" is a
 * valid, distinct segment from a space and round trips unchanged.
 */
export function isCanonicalScopePath(value: string): boolean {
  if (value.length === 0 || value.length > 4096) return false;
  if (!value.startsWith("/")) return false;
  for (const char of value) {
    if (char === "\\" || isControlChar(char)) return false;
  }
  if (value === "/") return true;
  if (value.endsWith("/")) return false;
  const segments = value.slice(1).split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") return false;
  }
  return true;
}

export const ScopeCanonicalPath = z
  .string()
  .max(4096)
  .refine(isCanonicalScopePath, { message: "must be an absolute, canonical path" });
export type ScopeCanonicalPath = z.infer<typeof ScopeCanonicalPath>;

/**
 * One root/filesystem-prefix to virtual-prefix mapping, as stored and
 * returned by the scope API. `fsPrefix` is a path relative to `rootName`'s
 * own mount; `virtualPrefix` is where it appears in the identity's virtual
 * filesystem.
 */
export const ScopeMapping = z.strictObject({
  rootName: ScopeRootName,
  fsPrefix: ScopeCanonicalPath,
  virtualPrefix: ScopeCanonicalPath,
});
export type ScopeMapping = z.infer<typeof ScopeMapping>;

/** The maximum number of scope mappings an identity may have, home scope included. */
export const MAX_SCOPE_MAPPINGS = 32;

/**
 * Body for `PUT /api/v1/account/identities/:id/scope`. An empty array
 * resets the identity to its template-derived home scope with no
 * overrides. `virtualPrefix` values must be unique within the request; the
 * server applies additional checks (known roots, no shadowing) that a
 * static schema cannot express.
 */
export const SetIdentityScopeRequest = z
  .strictObject({ scopes: z.array(ScopeMapping).max(MAX_SCOPE_MAPPINGS) })
  .refine(
    (body) => new Set(body.scopes.map((scope) => scope.virtualPrefix)).size === body.scopes.length,
    { message: "virtualPrefix must be unique across scopes", path: ["scopes"] },
  );
export type SetIdentityScopeRequest = z.infer<typeof SetIdentityScopeRequest>;

/**
 * Why an identity's index-backed features are unavailable, or "ok" when
 * they are available. Distinct reasons let the UI explain the failure
 * (misconfiguration vs. a transient outage) without ever claiming that
 * matching root/path names prove two storage locations are identical; see
 * `docs/workflow/P5-SCOPES.md`.
 */
export const IdentityScopeReason = z.enum([
  "ok",
  "no_connection",
  "provider_mismatch",
  "invalid_configuration",
  "no_roots",
  "mismatch",
  "overflow",
  "indexer_unreachable",
]);
export type IdentityScopeReason = z.infer<typeof IdentityScopeReason>;

const IdentityScopeStatusShape = {
  status: z.enum(["available", "unavailable"]),
  reason: IdentityScopeReason,
  /** Whether the identity currently has a stored override rather than the plain template. */
  usesOverride: z.boolean(),
  virtualPrefixes: z.array(z.string()).max(MAX_SCOPE_MAPPINGS),
  /** Standing advisory text: an administrator-controlled mapping is an authorization boundary, not proof that two matching names are the same storage. */
  warning: z.string(),
};

/**
 * Response for `GET /api/v1/account/identities/:id/scope`, discriminated
 * on `isAdmin`. A non-administrator sees only their own virtual mapping
 * and status; an administrator additionally sees every configured root
 * name and the full root/filesystem-prefix mapping, since that is the
 * information the mapping editor needs and disclosing it to a
 * non-administrator would leak another identity's physical layout.
 */
export const IdentityScopeResponse = z.discriminatedUnion("isAdmin", [
  z.strictObject({ ...IdentityScopeStatusShape, isAdmin: z.literal(false) }),
  z.strictObject({
    ...IdentityScopeStatusShape,
    isAdmin: z.literal(true),
    configuredRoots: z.array(z.string()).max(64),
    mappings: z.array(ScopeMapping).max(MAX_SCOPE_MAPPINGS),
  }),
]);
export type IdentityScopeResponse = z.infer<typeof IdentityScopeResponse>;
