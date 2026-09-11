import { isWithin, relativeTo, type Scope } from "@fdrive/core";
import type { DirectoryEntryLite } from "./types.ts";

/** The immediate child segment of `path` below `prefix`, or `null` when `path` is not strictly inside `prefix`. */
function firstSegmentBelow(prefix: string, path: string): string | null {
  if (path === prefix || !isWithin(prefix, path)) {
    return null;
  }
  // `isWithin` guarantees `path` is at or below `prefix` and they are not
  // equal (checked above), so `relativeTo` always succeeds here with a
  // non-empty remainder.
  const rel = relativeTo(prefix, path) ?? "";
  return rel.split("/")[0] ?? "";
}

/**
 * Child names of `scope`'s mount directory that must be excluded from its
 * own SFTP-vs-index directory verification, because a different, more
 * specific scope's `virtualPrefix` sits directly inside `scope`'s
 * `virtualPrefix` at that name. That subtree is shadowed: any content a
 * user sees there comes from the more specific mapping, never from
 * `scope`'s own disk location, so a mismatch there is expected and must
 * not be treated as an inconsistency. See the "shadowed same-name files"
 * case in `docs/SCOPING.md`.
 *
 * `unindexedPrefixes` (virtual prefixes an administrator has acknowledged
 * as present but not indexed) shadow a child name the same way; they grant
 * nothing else.
 */
export function shadowedChildNames(
  scope: Scope,
  allScopes: readonly Scope[],
  unindexedPrefixes: readonly string[] = [],
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const other of allScopes) {
    const name = firstSegmentBelow(scope.virtualPrefix, other.virtualPrefix);
    if (name !== null) names.add(name);
  }
  for (const prefix of unindexedPrefixes) {
    const name = firstSegmentBelow(scope.virtualPrefix, prefix);
    if (name !== null) names.add(name);
  }
  return names;
}

export interface VerifyMountDirectoryInput {
  readonly sftpEntries: readonly DirectoryEntryLite[];
  readonly indexEntries: readonly DirectoryEntryLite[];
  readonly indexOverflow: boolean;
  readonly excludedNames: ReadonlySet<string>;
}

/**
 * One SFTP-visible entry that failed verification. `missing` means the
 * index listing has no entry of that name at all: for a directory or file
 * this is what an unmapped SFTPGo virtual-folder mount looks like from the
 * outside, since a mount is never a real entry on disk in the user's home.
 * `kind_mismatch` means the index knows the name but as a different kind:
 * a genuine inconsistency between the two views of the same directory.
 */
export interface MountDirectoryOffender {
  readonly name: string;
  readonly kind: DirectoryEntryLite["kind"];
  readonly problem: "missing" | "kind_mismatch";
}

export type VerifyMountDirectoryResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "overflow" }
  | {
      readonly ok: false;
      readonly reason: "mismatch";
      /** Every offending entry, in SFTP listing order; never empty. */
      readonly entries: readonly MountDirectoryOffender[];
    };

/**
 * Compares one scope's live SFTP directory listing against the indexer's
 * own view of the same mount directory. Every SFTP-visible entry (other
 * than a shadowed name) must appear in the index listing with the same
 * kind; extra index/disk entries are permitted (SFTP hidden-file filters
 * and similar). An overflowed index listing is inconclusive and always
 * fails. An empty SFTP listing trivially passes: this is a consistency
 * check, not proof that the two locations are the same storage. A failing
 * result names every offending entry so the caller can tell an unmapped
 * mount (every entry `missing`) from a real inconsistency.
 */
export function verifyMountDirectory(input: VerifyMountDirectoryInput): VerifyMountDirectoryResult {
  if (input.indexOverflow) {
    return { ok: false, reason: "overflow" };
  }

  const indexKindByName = new Map(input.indexEntries.map((entry) => [entry.name, entry.kind]));
  const entries: MountDirectoryOffender[] = [];

  for (const entry of input.sftpEntries) {
    if (input.excludedNames.has(entry.name)) {
      continue;
    }
    const indexKind = indexKindByName.get(entry.name);
    if (indexKind === undefined) {
      entries.push({ name: entry.name, kind: entry.kind, problem: "missing" });
    } else if (indexKind !== entry.kind) {
      entries.push({ name: entry.name, kind: entry.kind, problem: "kind_mismatch" });
    }
  }

  return entries.length === 0 ? { ok: true } : { ok: false, reason: "mismatch", entries };
}
