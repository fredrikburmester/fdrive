import {
  ApiClientError,
  type IdentityScopeReason,
  type IdentityScopeResponse,
  isCanonicalScopePath,
  type MountMapping,
  type ScopeMapping,
  type SetIdentityScopeRequestInput,
  type SetMountMappingsRequest,
} from "@fdrive/contracts";
import { describeApiError } from "@/lib/api/errors";

/** The administrator's view of a login's scope, which carries the stored overrides the editor edits. */
export type AdminScopeStatus = Extract<IdentityScopeResponse, { isAdmin: true }>;

/** One sentence per `IdentityScopeReason`, for the status line under a login. */
export const SCOPE_REASON_TEXT: Record<IdentityScopeReason, string> = {
  ok: "Search, thumbnails, and other index-backed features are available.",
  no_connection: "No storage provider is configured.",
  provider_mismatch: "This login belongs to a different server than the one configured.",
  invalid_configuration: "The home template cannot be applied to this login.",
  no_roots: "None of this login's folders are on an indexed root.",
  mismatch: "The files this login shows do not match what the indexer sees at the mapped location.",
  overflow: "The mapped directory has too many entries to verify.",
  indexer_unreachable: "The indexer is not reachable right now.",
  unmapped_mount:
    "A folder this login shows is not indexed. Map it, or mark it not indexed, to restore search for this login.",
};

/** A mapping the editor is about to add for an unmapped mount. */
export interface MountMappingDraft {
  readonly virtualPrefix: string;
  readonly rootName: string;
  readonly fsPrefix: string;
}

/**
 * The `PUT` body that maps `draft` on top of the stored overrides, leaving
 * every other override and acknowledgement in place. A stale acknowledgement
 * for the same path is dropped: a mapped folder is no longer "not indexed".
 */
export function requestWithMapping(
  status: AdminScopeStatus,
  draft: MountMappingDraft,
): SetIdentityScopeRequestInput {
  const mapping: ScopeMapping = {
    rootName: draft.rootName,
    fsPrefix: draft.fsPrefix,
    virtualPrefix: draft.virtualPrefix,
  };
  return {
    scopes: [
      ...status.overrides.filter((scope) => scope.virtualPrefix !== mapping.virtualPrefix),
      mapping,
    ],
    unindexedPrefixes: status.unindexedPrefixes.filter(
      (prefix) => prefix !== mapping.virtualPrefix,
    ),
  };
}

/** The `PUT` body that acknowledges `virtualPath` as present but not indexed, keeping everything else. */
export function requestWithUnindexed(
  status: AdminScopeStatus,
  virtualPath: string,
): SetIdentityScopeRequestInput {
  return {
    scopes: status.overrides.filter((scope) => scope.virtualPrefix !== virtualPath),
    unindexedPrefixes: status.unindexedPrefixes.includes(virtualPath)
      ? status.unindexedPrefixes
      : [...status.unindexedPrefixes, virtualPath],
  };
}

/** The `PUT` body with the override or acknowledgement at `virtualPath` removed. */
export function requestWithoutPrefix(
  status: AdminScopeStatus,
  virtualPath: string,
): SetIdentityScopeRequestInput {
  return {
    scopes: status.overrides.filter((scope) => scope.virtualPrefix !== virtualPath),
    unindexedPrefixes: status.unindexedPrefixes.filter((prefix) => prefix !== virtualPath),
  };
}

/**
 * The folder-mapping list with `draft` mapped for every login that mounts
 * `draft.virtualPrefix`, replacing any existing folder mapping at that path.
 */
export function mountMappingsWith(
  current: readonly MountMapping[],
  draft: MountMappingDraft,
): SetMountMappingsRequest {
  return {
    mappings: [
      ...current.filter((mapping) => mapping.virtualPath !== draft.virtualPrefix),
      { virtualPath: draft.virtualPrefix, rootName: draft.rootName, fsPrefix: draft.fsPrefix },
    ],
  };
}

/** The folder-mapping list without the mapping at `virtualPath`. */
export function mountMappingsWithout(
  current: readonly MountMapping[],
  virtualPath: string,
): SetMountMappingsRequest {
  return { mappings: current.filter((mapping) => mapping.virtualPath !== virtualPath) };
}

/** Client-side check for the one free-text field, so an obvious typo never round-trips. */
export function fsPrefixProblem(fsPrefix: string): string | null {
  if (fsPrefix.trim().length === 0) return "Enter the folder's path inside the root.";
  if (!isCanonicalScopePath(fsPrefix)) {
    return "Enter an absolute path such as /_folders/shared, with no trailing slash.";
  }
  return null;
}

export type ScopeErrorField = "rootName" | "fsPrefix" | "virtualPrefix" | "unindexedPrefixes";

/** A save failure mapped to the field it concerns, or to the form when no single field is at fault. */
export interface ScopeSaveError {
  readonly field: ScopeErrorField | null;
  readonly message: string;
}

const REASON_ERRORS: Record<string, ScopeSaveError> = {
  unknown_root: { field: "rootName", message: "That root is not configured on this server." },
  duplicate_virtual_prefix: {
    field: "virtualPrefix",
    message: "Another mapping already uses that path.",
  },
  invalid_mapping: {
    field: "fsPrefix",
    message: "Enter an absolute path such as /_folders/shared, with no trailing slash.",
  },
  too_many: { field: null, message: "This login already has the maximum number of mappings." },
  invalid_unindexed_prefix: {
    field: "unindexedPrefixes",
    message: "A not-indexed path must be absolute, with no trailing slash.",
  },
  duplicate_unindexed_prefix: {
    field: "unindexedPrefixes",
    message: "That path is already marked not indexed.",
  },
  unindexed_prefix_collision: {
    field: "unindexedPrefixes",
    message: "That path is already mapped, so it cannot also be marked not indexed.",
  },
};

function fromIssue(issue: unknown): ScopeSaveError | null {
  if (typeof issue !== "object" || issue === null) return null;
  const { path, message } = issue as { path?: unknown; message?: unknown };
  const head = Array.isArray(path) ? path[0] : undefined;
  const text = typeof message === "string" ? message : "";
  if (head === "unindexedPrefixes") {
    return /collide/i.test(text)
      ? (REASON_ERRORS.unindexed_prefix_collision ?? null)
      : /unique/i.test(text)
        ? (REASON_ERRORS.duplicate_unindexed_prefix ?? null)
        : (REASON_ERRORS.invalid_unindexed_prefix ?? null);
  }
  if (head === "scopes") {
    if (/unique/i.test(text)) return REASON_ERRORS.duplicate_virtual_prefix ?? null;
    const leaf = Array.isArray(path) ? path.at(-1) : undefined;
    if (leaf === "rootName") return REASON_ERRORS.unknown_root ?? null;
    if (leaf === "virtualPrefix") {
      return { field: "virtualPrefix", message: "Enter an absolute path with no trailing slash." };
    }
    return REASON_ERRORS.invalid_mapping ?? null;
  }
  return null;
}

/**
 * Turns a failed `PUT` into one sentence attached to the field at fault.
 * The route reports the resolver's validation reason in `details.reason`
 * and schema failures as zod `details.issues`; anything else falls back to
 * the shared API error wording.
 */
export function describeScopeError(error: unknown): ScopeSaveError {
  if (error instanceof ApiClientError) {
    if (error.kind === "forbidden") {
      return { field: null, message: "Only an administrator can change mappings." };
    }
    if (error.kind === "bad_request") {
      const reason = error.details?.reason;
      if (typeof reason === "string" && reason in REASON_ERRORS) {
        return REASON_ERRORS[reason] as ScopeSaveError;
      }
      const issues = error.details?.issues;
      if (Array.isArray(issues)) {
        for (const issue of issues) {
          const mapped = fromIssue(issue);
          if (mapped !== null) return mapped;
        }
      }
    }
  }
  return { field: null, message: describeApiError(error) };
}
