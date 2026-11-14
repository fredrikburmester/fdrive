import { createHash } from "node:crypto";
import { type DesktopChangesResponse, DesktopPath } from "@fdrive/contracts";
import { isUnderPath, parentPath, type Scope } from "@fdrive/core";
import type { Change, ChangeJournal } from "@fdrive/db";
import type { Principal } from "../auth/principal.js";
import { ApiHttpError } from "../errors.js";
import { roundTripVirtualPath } from "../scoping/round-trip.js";
import type { VerifiedIndexScopesResult } from "../scoping/types.js";
import { desktopPathAllowed } from "./files.js";

/** Journal rows per answer; while `more` is set the client asks again from the anchor. */
export const DESKTOP_CHANGES_PAGE = 1_000;

export interface DesktopChangesDeps {
  readonly journal: Pick<ChangeJournal, "read" | "end" | "epoch">;
  /** Every index root the indexer has created, by name. */
  readonly rootIds: () => Promise<Readonly<Record<string, number>>>;
  /** The identity's verified index scopes, or `null` when the identity is gone. */
  readonly scopes: (identityId: string) => Promise<VerifiedIndexScopesResult | null>;
  /**
   * The roots this API journals its own changes under. Changes made through
   * fdrive reach the journal only for these, so a feed over any other root
   * would miss them.
   */
  readonly journaledRoots: ReadonlySet<string>;
  readonly trashPathForStorage: (storage: Principal["storage"]) => string | null;
  readonly pageSize?: number;
}

/** One location's view of the journal: its scopes, their roots and a fingerprint of both. */
interface Feed {
  readonly scopes: readonly Scope[];
  readonly roots: readonly string[];
  readonly fingerprint: string;
}

const ANCHOR = /^v1\.([0-9a-f-]{36})\.([0-9a-f]{16})\.(\d{1,15})$/;

/** Orders a folder's descendants straight after it. */
const treeOrder = (path: string) => path.replaceAll("/", "\u0000");
const byTree = (a: string, b: string) => (treeOrder(a) < treeOrder(b) ? -1 : 1);
const representable = (path: string) => DesktopPath.safeParse(path).success;

/**
 * What journal rows mean for one desktop connection, in its own paths.
 *
 * Each end of a row (`path`, and `target_path` for a move) is mapped from the
 * root-relative path through the connection's index scopes with the same
 * round trip index reads use, so a path no scope covers, or one a shared
 * folder shadows, is dropped, as is anything listings hide (Trash, fdrive's
 * own desktop folder, outside the grants). A row does not say whether it is
 * a file or a folder, so each kept end is a changed `path`: the client lists
 * every browsed folder at or below it again and checks every downloaded file
 * there. Its parent's listing changed, and so did its grandparent's, which
 * shows the parent's modification time, so both are `folders`. Duplicates
 * collapse, and paths and folders already covered by an outer changed path
 * are left out.
 */
export function changedPaths(
  changes: readonly Pick<Change, "root" | "path" | "targetPath">[],
  scopes: readonly Scope[],
  visible: (path: string) => boolean,
): { paths: string[]; folders: string[] } {
  const paths = new Set<string>();
  const folders = new Set<string>();
  for (const change of changes) {
    const ends = change.targetPath === null ? [change.path] : [change.path, change.targetPath];
    for (const end of ends) {
      const path = roundTripVirtualPath(scopes, change.root, `/${end}`);
      if (path === null || !visible(path)) continue;
      paths.add(path);
      let folder = path;
      for (let level = 0; level < 2 && folder !== "/"; level++) {
        folder = parentPath(folder);
        folders.add(folder);
      }
    }
  }
  const outer: string[] = [];
  for (const path of [...paths].sort(byTree)) {
    const last = outer.at(-1);
    if (last !== undefined && isUnderPath(last, path)) continue;
    outer.push(path);
  }
  const covering = new Set(outer);
  const covered = (folder: string) => {
    for (let at = folder; ; at = parentPath(at)) {
      if (covering.has(at)) return true;
      if (at === "/") return false;
    }
  };
  return {
    paths: outer.filter(representable),
    folders: [...folders]
      .filter((folder) => !covered(folder) && visible(folder) && representable(folder))
      .sort(byTree),
  };
}

/**
 * The Mac app's change feed (`GET /api/v2/desktop/changes`): which of a
 * location's folders changed since an anchor, read from the change journal.
 *
 * An anchor is `v1.<epoch>.<fingerprint>.<position>`. The epoch changes when
 * positions start again (a restore), and the fingerprint when the location's
 * scopes or their roots do (a folder shared or unshared, a root created
 * again), and either answers `resync`, as do an unreadable anchor, one past
 * the journal's end and a gap. Without an anchor the answer is a `resync`
 * from the journal's end, so a new client checks its folders once and goes
 * on from there. See docs/MACOS.md and docs/plans/CHANGE-JOURNAL.md.
 */
export function createDesktopChanges(deps: DesktopChangesDeps) {
  const pageSize = deps.pageSize ?? DESKTOP_CHANGES_PAGE;

  /** The location's feed, or `null` when the journal cannot see all of its changes. */
  async function feed(principal: Principal): Promise<Feed | null> {
    const verified = await deps.scopes(principal.identityId);
    if (verified === null || !verified.available) return null;
    const roots = [...new Set(verified.scopes.map((scope) => scope.rootName))].sort();
    if (!roots.every((root) => deps.journaledRoots.has(root))) return null;
    const ids = await deps.rootIds();
    if (!roots.every((root) => ids[root] !== undefined)) return null;
    const shape = {
      roots: roots.map((root) => [root, ids[root]]),
      scopes: verified.scopes
        .map((scope) => JSON.stringify([scope.rootName, scope.fsPrefix, scope.virtualPrefix]))
        .sort(),
    };
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(shape))
      .digest("hex")
      .slice(0, 16);
    return { scopes: verified.scopes, roots, fingerprint };
  }

  return {
    /** Whether the location has a feed: advertised in its v2 `location`. */
    async available(principal: Principal): Promise<boolean> {
      return (await feed(principal)) !== null;
    },

    async read(principal: Principal, since: string | undefined): Promise<DesktopChangesResponse> {
      const current = await feed(principal);
      if (current === null)
        throw new ApiHttpError("not_found", "This location has no change feed on this server");
      const epoch = await deps.journal.epoch();
      const end = await deps.journal.end();
      const anchor = (position: number) => `v1.${epoch}.${current.fingerprint}.${position}`;
      const from = ANCHOR.exec(since ?? "");
      // Fifteen digits at most, so always a safe integer.
      const position = Number(from?.[3]);
      if (from?.[1] !== epoch || from[2] !== current.fingerprint || position > end)
        return { status: "resync", anchor: anchor(end) };
      const page = await deps.journal.read(current.roots, position, pageSize);
      if (page.gap) return { status: "resync", anchor: anchor(end) };
      const more = page.changes.length >= pageSize;
      const last = page.changes.at(-1)?.position ?? position;
      const trash = deps.trashPathForStorage(principal.storage);
      const { paths, folders } = changedPaths(page.changes, current.scopes, (path) =>
        desktopPathAllowed(principal, path, { trash, writeProtocol: true, browse: true }),
      );
      // A complete page read every row after the position, and every row up to
      // `end` had committed before it: the next read may start past both.
      return {
        status: "changes",
        paths,
        folders,
        anchor: anchor(more ? last : Math.max(end, last)),
        more,
      };
    },
  };
}

export type DesktopChanges = ReturnType<typeof createDesktopChanges>;
