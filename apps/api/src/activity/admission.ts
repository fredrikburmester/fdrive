import { createHmac } from "node:crypto";
import type { ClientActivityRequest } from "@fdrive/contracts";
import type { ActivityReadsRepo, ActivityRepo, ShareRepo } from "@fdrive/db";
import { accountContext } from "../auth/account-context.ts";
import { ApiHttpError } from "../errors.js";
import { type FsContext, normalizeOrThrow, runStorageCall } from "../fs/routes.js";
import { createActivityLimiter } from "./limiter.js";

export interface ActivityAdmissionDeps {
  readonly reads: ActivityReadsRepo;
  readonly repo: ActivityRepo;
  readonly secret: string;
  readonly clock: () => Date;
  readonly shares: ShareRepo;
}

/**
 * Turns a client-reported gesture of the caller's login into a read window or
 * client event. Every report is re-proved here: the timestamp is recent and
 * the file is in the caller's storage right now. The session id
 * never reaches history; only its keyed hash does, so repeated gestures in one
 * session aggregate without storing the session itself.
 */
export function createActivityAdmission(deps: ActivityAdmissionDeps) {
  const admit = createActivityLimiter(300, deps.clock);
  // `at` is optional because a server-side producer such as `POST
  // /recents/touch` has no client timestamp to forward; the API clock stamps
  // those. A real client report still has to be recent.
  return async (c: FsContext, input: Omit<ClientActivityRequest, "at"> & { at?: string }) => {
    const { principal, sessionId } = accountContext(c);
    admit(principal.accountId);
    const identityId = principal.identityId;
    const now = deps.clock();
    const at = input.at === undefined ? now : new Date(input.at);
    if (at.getTime() < now.getTime() - 600_000 || at.getTime() > now.getTime() + 60_000)
      throw new ApiHttpError("bad_request", "Activity report expired");
    const path = normalizeOrThrow(input.path);
    const stat = await runStorageCall(() => principal.storage.stat(path));
    const kind = stat.kind === "dir" ? "dir" : "file";
    const contextHash = createHmac("sha256", deps.secret)
      .update(`activity-context:${sessionId}`)
      .digest("hex");
    if (input.action === "share.copy_link") {
      const share = input.shareId ? await deps.shares.getOwned(identityId, input.shareId) : null;
      if (!share?.paths.includes(path))
        throw new ApiHttpError("forbidden", "Share does not include this file");
      return (
        await deps.repo.clientEvent(
          principal.accountId,
          contextHash,
          { ...input, identityId, path, at: at.toISOString() },
          kind,
        )
      ).id;
    }
    return deps.reads.record({
      accountId: principal.accountId,
      identityId,
      path,
      kind,
      action: input.action,
      source: "web",
      evidence: "client_reported",
      contextHash,
      requestId: input.requestId,
      at,
      outcome: "unknown",
    });
  };
}
export type ActivityAdmission = ReturnType<typeof createActivityAdmission>;
