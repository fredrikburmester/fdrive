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
 * Body for `PUT /api/v1/account/identities/:id/scope`. An empty `scopes`
 * array (with no `unindexedPrefixes`) resets the identity to its
 * template-derived home scope with no overrides. `virtualPrefix` values must
 * be unique within the request; the server applies additional checks
 * (known roots, no shadowing) that a static schema cannot express.
 *
 * `unindexedPrefixes` are virtual prefixes (typically SFTPGo virtual-folder
 * mounts) an administrator has acknowledged as present but deliberately not
 * indexed: they are excluded from the enclosing scope's directory
 * verification and nothing else. They grant no read access, map to no
 * root, and never become scopes, so they must not collide with any
 * `scopes[].virtualPrefix`.
 */
export const SetIdentityScopeRequest = z
  .strictObject({
    scopes: z.array(ScopeMapping).max(MAX_SCOPE_MAPPINGS),
    unindexedPrefixes: z.array(ScopeCanonicalPath).max(MAX_SCOPE_MAPPINGS).default([]),
  })
  .refine(
    (body) => new Set(body.scopes.map((scope) => scope.virtualPrefix)).size === body.scopes.length,
    { message: "virtualPrefix must be unique across scopes", path: ["scopes"] },
  )
  .refine((body) => new Set(body.unindexedPrefixes).size === body.unindexedPrefixes.length, {
    message: "unindexedPrefixes must be unique",
    path: ["unindexedPrefixes"],
  })
  .refine(
    (body) => {
      const mapped = new Set(body.scopes.map((scope) => scope.virtualPrefix));
      return body.unindexedPrefixes.every((prefix) => !mapped.has(prefix));
    },
    {
      message: "unindexedPrefixes must not collide with a mapped virtualPrefix",
      path: ["unindexedPrefixes"],
    },
  );
export type SetIdentityScopeRequest = z.infer<typeof SetIdentityScopeRequest>;
/** The request as a client sends it: `unindexedPrefixes` may be omitted and defaults to `[]`. */
export type SetIdentityScopeRequestInput = z.input<typeof SetIdentityScopeRequest>;

/**
 * Why an identity's index-backed features are unavailable, or "ok" when
 * they are available. Distinct reasons let the UI explain the failure
 * (misconfiguration vs. a transient outage) without ever claiming that
 * matching root/path names prove two storage locations are identical; see
 * `docs/workflow/P5-SCOPES.md`. `unmapped_mount` is reported instead of
 * `mismatch` when every entry SFTP shows but the index lacks is a plausible
 * SFTPGo virtual-folder mount, i.e. a mapping is missing rather than wrong.
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
  "unmapped_mount",
]);
export type IdentityScopeReason = z.infer<typeof IdentityScopeReason>;

/**
 * One folder-level mapping: applies to every login whose verification finds
 * an unmapped mount at exactly `virtualPath`. Stored once, globally; never
 * for the root itself, which is always the template-derived home scope.
 */
export const MountMapping = z.strictObject({
  virtualPath: ScopeCanonicalPath.refine((value) => value !== "/", {
    message: "a folder mapping cannot target the root",
  }),
  rootName: ScopeRootName,
  fsPrefix: ScopeCanonicalPath,
});
export type MountMapping = z.infer<typeof MountMapping>;

/** The maximum number of folder-level mappings. */
export const MAX_MOUNT_MAPPINGS = 64;

/** `GET /api/v1/system/mount-mappings` response, and the shape `PUT` returns. */
export const MountMappingsResponse = z.strictObject({
  mappings: z.array(MountMapping).max(MAX_MOUNT_MAPPINGS),
});
export type MountMappingsResponse = z.infer<typeof MountMappingsResponse>;

/** `PUT /api/v1/system/mount-mappings` body: replaces the whole list; `virtualPath` must be unique. */
export const SetMountMappingsRequest = z
  .strictObject({ mappings: z.array(MountMapping).max(MAX_MOUNT_MAPPINGS) })
  .refine(
    (body) =>
      new Set(body.mappings.map((mapping) => mapping.virtualPath)).size === body.mappings.length,
    { message: "virtualPath must be unique across folder mappings", path: ["mappings"] },
  );
export type SetMountMappingsRequest = z.infer<typeof SetMountMappingsRequest>;

/** A physical location whose indexed content matches an unmapped mount's live listing. */
export const ScopeMappingSuggestion = z.strictObject({
  rootName: ScopeRootName,
  fsPrefix: ScopeCanonicalPath,
});
export type ScopeMappingSuggestion = z.infer<typeof ScopeMappingSuggestion>;

/** The maximum number of suggestions per unmapped mount. */
export const MAX_SCOPE_SUGGESTIONS = 5;

/**
 * `GET /api/v1/account/identities/:id/scope/suggestions` response: one entry
 * per unmapped directory mount, in status order, each with the confirmed
 * candidate locations (possibly none). A suggestion is a hint the
 * administrator confirms by saving a mapping; it grants nothing by itself.
 */
export const IdentityScopeSuggestionsResponse = z.strictObject({
  mounts: z
    .array(
      z.strictObject({
        virtualPath: ScopeCanonicalPath,
        suggestions: z.array(ScopeMappingSuggestion).max(MAX_SCOPE_SUGGESTIONS),
      }),
    )
    .max(64),
});
export type IdentityScopeSuggestionsResponse = z.infer<typeof IdentityScopeSuggestionsResponse>;

/** The maximum number of unmapped mounts one status reports, across every scope. */
export const MAX_UNMAPPED_MOUNTS = 64;

/**
 * One SFTP-visible entry the index does not know about at a scope's mount
 * directory: most likely an SFTPGo virtual folder that has no fdrive
 * mapping yet. `virtualPath` is where the identity sees it.
 */
export const UnmappedMount = z.strictObject({
  virtualPath: ScopeCanonicalPath,
  kind: z.enum(["file", "dir"]),
});
export type UnmappedMount = z.infer<typeof UnmappedMount>;

const IdentityScopeStatusShape = {
  status: z.enum(["available", "unavailable"]),
  reason: IdentityScopeReason,
  /** Whether the identity currently has a stored override rather than the plain template. */
  usesOverride: z.boolean(),
  virtualPrefixes: z.array(z.string()).max(MAX_SCOPE_MAPPINGS),
  /** SFTP-visible entries missing from the index that look like unmapped mounts; virtual paths, so visible to both roles. */
  unmappedMounts: z.array(UnmappedMount).max(MAX_UNMAPPED_MOUNTS),
  /** Virtual prefixes dropped from the verified set while at least one other scope survived. */
  unverifiedPrefixes: z.array(z.string()).max(MAX_SCOPE_MAPPINGS),
  /** The stored `unindexedPrefixes` acknowledgements, so an editor can carry them into its next `PUT`. */
  unindexedPrefixes: z.array(z.string()).max(MAX_SCOPE_MAPPINGS),
  /** Standing advisory text: an administrator-controlled mapping is an authorization boundary, not proof that two matching names are the same storage. */
  warning: z.string(),
};

/**
 * Response for `GET /api/v1/account/identities/:id/scope`, discriminated
 * on `isAdmin`. A non-administrator sees only their own virtual mapping
 * and status; an administrator additionally sees every configured root
 * name, the full root/filesystem-prefix mapping, and the stored overrides
 * on their own, since that is the information the mapping editor needs and
 * disclosing it to a non-administrator would leak another identity's
 * physical layout.
 */
export const IdentityScopeResponse = z.discriminatedUnion("isAdmin", [
  z.strictObject({ ...IdentityScopeStatusShape, isAdmin: z.literal(false) }),
  z.strictObject({
    ...IdentityScopeStatusShape,
    isAdmin: z.literal(true),
    configuredRoots: z.array(z.string()).max(64),
    /** The effective mapping: the template-derived home scope with the stored overrides applied. */
    mappings: z.array(ScopeMapping).max(MAX_SCOPE_MAPPINGS),
    /** Only the stored overrides, i.e. exactly what the next `PUT` should carry to leave them unchanged. */
    overrides: z.array(ScopeMapping).max(MAX_SCOPE_MAPPINGS),
    /** Folder-level mappings currently adopted for this login (an unmapped mount matched their `virtualPath`). */
    adoptedMappings: z.array(ScopeMapping).max(MAX_MOUNT_MAPPINGS),
  }),
]);
export type IdentityScopeResponse = z.infer<typeof IdentityScopeResponse>;
