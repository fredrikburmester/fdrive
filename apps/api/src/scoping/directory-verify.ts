import { isWithin, relativeTo, type Scope } from "@fdrive/core";
import type { DirectoryEntryLite } from "./types.ts";

/**
 * Child names of `scope`'s mount directory that must be excluded from its
 * own SFTP-vs-index directory verification, because a different, more
 * specific scope's `virtualPrefix` sits directly inside `scope`'s
 * `virtualPrefix` at that name. That subtree is shadowed: any content a
 * user sees there comes from the more specific mapping, never from
 * `scope`'s own disk location, so a mismatch there is expected and must
 * not be treated as an inconsistency. See the "shadowed same-name files"
 * case in `docs/workflow/P5-SCOPES.md`.
 */
export function shadowedChildNames(scope: Scope, allScopes: readonly Scope[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const other of allScopes) {
    if (other.virtualPrefix === scope.virtualPrefix) {
      continue;
    }
    if (!isWithin(scope.virtualPrefix, other.virtualPrefix)) {
      continue;
    }
    // `isWithin` above already guarantees `other.virtualPrefix` is at or
    // below `scope.virtualPrefix` and they are not equal (filtered above),
    // so `relativeTo` always succeeds here with a non-empty remainder.
    const rel = relativeTo(scope.virtualPrefix, other.virtualPrefix) ?? "";
    const firstSegment = rel.split("/")[0] ?? "";
    names.add(firstSegment);
  }
  return names;
}

export interface VerifyMountDirectoryInput {
  readonly sftpEntries: readonly DirectoryEntryLite[];
  readonly indexEntries: readonly DirectoryEntryLite[];
  readonly indexOverflow: boolean;
  readonly excludedNames: ReadonlySet<string>;
}

export type VerifyMountDirectoryResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "overflow" | "mismatch" };

/**
 * Compares one scope's live SFTP directory listing against the indexer's
 * own view of the same mount directory. Every SFTP-visible entry (other
 * than a shadowed name) must appear in the index listing with the same
 * kind; extra index/disk entries are permitted (SFTP hidden-file filters
 * and similar). An overflowed index listing is inconclusive and always
 * fails. An empty SFTP listing trivially passes: this is a consistency
 * check, not proof that the two locations are the same storage.
 */
export function verifyMountDirectory(input: VerifyMountDirectoryInput): VerifyMountDirectoryResult {
  if (input.indexOverflow) {
    return { ok: false, reason: "overflow" };
  }

  const indexKindByName = new Map(input.indexEntries.map((entry) => [entry.name, entry.kind]));

  for (const entry of input.sftpEntries) {
    if (input.excludedNames.has(entry.name)) {
      continue;
    }
    const indexKind = indexKindByName.get(entry.name);
    if (indexKind === undefined || indexKind !== entry.kind) {
      return { ok: false, reason: "mismatch" };
    }
  }

  return { ok: true };
}
