import {
  ApiTokenAccess,
  CanonicalUuid,
  DESKTOP_API,
  DesktopChangeAnchor,
  DesktopFolderCheckRequest,
  DesktopFolderRequest,
  DesktopMoveRequest,
  DesktopPairApproval,
  DesktopPairRequest,
  DesktopPairSecret,
  DesktopPath,
  DesktopUploadRequest,
  DesktopVersionRequest,
} from "@fdrive/contracts";
import type { Context } from "hono";
import { activityOperationId } from "../activity/fs-context.js";
import type { PersonalActivityService } from "../activity/service.js";
import { activityStream } from "../activity/streams.js";
import type { AppHono, AuthedHono } from "../app.js";
import { accountContext } from "../auth/account-context.ts";
import type { Principal } from "../auth/principal.js";
import { ApiHttpError } from "../errors.js";
import { parseBody } from "../fs/routes.js";
import { hashApiToken } from "../tokens/token-format.js";
import type { DesktopChanges } from "./changes.js";
import { createDesktopFiles } from "./files.js";
import { createDesktopPairing, type DesktopDeps } from "./pairing.js";
import { CREDENTIAL_GONE, looksLikeDesktopToken } from "./tokens.js";
import type { DesktopWrites } from "./writes.js";

export function registerDesktopRoutes(
  groups: { public: AppHono; authed: AuthedHono; v2?: AppHono },
  deps: DesktopDeps & {
    clientIp: (c: Context) => string;
    writes?: DesktopWrites;
    /** The change feed; absent where the server keeps no change journal. */
    changes?: DesktopChanges;
    /** Records hydration. A background fetch is not a proven human open. */
    activity?: PersonalActivityService;
  },
) {
  const base = DESKTOP_API.slice("/api/v1".length);
  const writes = deps.writes;
  const writeService = () => {
    if (!deps.writes) throw new ApiHttpError("not_found", "Desktop writes are unavailable");
    return deps.writes;
  };
  const changes = deps.changes;
  const pairing = createDesktopPairing({
    ...deps,
    ...(writes
      ? { writeCapabilities: (principal: Principal) => writes.capabilities(principal) }
      : {}),
    ...(changes ? { changeFeed: true } : {}),
  });
  const files = createDesktopFiles(deps);
  function path(c: Context) {
    const parsed = DesktopPath.safeParse(c.req.query("path"));
    if (!parsed.success) throw new ApiHttpError("bad_request", "Invalid file path");
    return parsed.data;
  }
  /** The caller's own ID for one hydration, distinct from a write's operation ID. */
  const hydrationId = (c: Context) => activityOperationId(c.req.header("x-fdrive-operation-id"));
  /**
   * Why a desktop bearer was refused. A well-formed desktop credential this server holds no
   * row for is gone for good: revoked from the web or the Mac, deleted with its login or
   * account, or cleared by a restore. Its 401 says so with `credential_gone`, and the Mac
   * removes that location instead of asking again. Every other refusal (an expired
   * credential, an unreadable grant, a missing or malformed bearer) stays a plain 401,
   * which the Mac shows as signed out.
   */
  async function refused(bearer: string): Promise<ApiHttpError> {
    if (
      looksLikeDesktopToken(bearer) &&
      (await deps.apiTokens.findByHash(hashApiToken(bearer))) === null
    )
      return new ApiHttpError("unauthorized", "This connection no longer exists. Connect again", {
        code: CREDENTIAL_GONE,
      });
    return new ApiHttpError("unauthorized", "Reconnect this location in the Mac app");
  }
  async function principal(
    c: Context,
    writeProtocol = false,
  ): Promise<{ bearer: string; principal: Principal }> {
    c.header("Cache-Control", "no-store");
    const bearer = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
    const resolved = await pairing.resolve(bearer);
    if (!resolved) throw await refused(bearer);
    if (
      resolved.tokenAccess?.mode !== "read" &&
      !(writeProtocol && resolved.tokenAccess?.mode === "full")
    )
      throw new ApiHttpError("unauthorized", "Reconnect this location in the Mac app");
    const hash = hashApiToken(bearer);
    return {
      bearer,
      principal: {
        ...resolved,
        // A write's one recheck right before it publishes (`writes.ts`), in
        // one read: the token still exists, unexpired, for this login, with
        // the grant it had when the request began.
        verifyAuthority: async () => {
          const token = await deps.apiTokens.findByHash(hash);
          const access = ApiTokenAccess.safeParse(token?.access);
          return (
            token !== null &&
            access.success &&
            (token.expiresAt === null || token.expiresAt.getTime() > deps.clock().getTime()) &&
            token.accountId === resolved.accountId &&
            token.identityId === resolved.identityId &&
            JSON.stringify(access.data) === JSON.stringify(resolved.tokenAccess)
          );
        },
      },
    };
  }
  groups.public.post(`${base}/pairings`, async (c) => {
    const body = await parseBody(DesktopPairRequest, c);
    c.header("Cache-Control", "no-store");
    return c.json(pairing.create(body.deviceName, deps.clientIp(c)), 201);
  });
  groups.public.post(`${base}/pairings/:id/poll`, async (c) => {
    const body = await parseBody(DesktopPairSecret, c);
    c.header("Cache-Control", "no-store");
    return c.json(await pairing.poll(c.req.param("id"), body.secret));
  });
  groups.public.post(`${base}/pairings/:id/cancel`, async (c) => {
    const body = await parseBody(DesktopPairSecret, c);
    c.header("Cache-Control", "no-store");
    await pairing.cancel(c.req.param("id"), body.secret);
    return c.json({ ok: true });
  });
  groups.public.post(`${base}/pairings/:id/confirm`, async (c) => {
    const body = await parseBody(DesktopPairSecret, c);
    c.header("Cache-Control", "no-store");
    await pairing.confirm(c.req.param("id"), body.secret);
    return c.json({ ok: true });
  });
  groups.authed.get(`${base}/pairings/:id`, (c) => {
    accountContext(c);
    return c.json(pairing.info(c.req.param("id")));
  });
  groups.authed.post(`${base}/pairings/:id/approve`, async (c) => {
    const { principal } = accountContext(c);
    const body = await parseBody(DesktopPairApproval, c);
    await pairing.approve(c.req.param("id"), principal, body.access);
    return c.json({ ok: true });
  });
  groups.public.get(`${base}/location`, async (c) =>
    c.json(await pairing.location((await principal(c)).principal)),
  );
  groups.public.get(`${base}/entries`, async (c) => {
    const auth = await principal(c);
    return c.json(
      await files.list(auth.principal, path(c), hashApiToken(auth.bearer), c.req.query("cursor")),
    );
  });
  groups.public.get(`${base}/entry`, async (c) =>
    c.json(await files.stat((await principal(c)).principal, path(c))),
  );
  groups.public.get(`${base}/content`, async (c) => {
    const auth = await principal(c);
    const result = await files.content(auth.principal, path(c), c.req.raw.signal);
    c.header("Content-Type", "application/octet-stream");
    if (result.contentLength !== null) c.header("Content-Length", String(result.contentLength));
    return c.body(
      await activityStream(
        deps.activity,
        auth.principal,
        path(c),
        "file.materialize",
        result.body,
        {
          // A hydration the client retries under one ID is one materialization.
          ...(hydrationId(c) ? { requestId: hydrationId(c) as string } : {}),
          expectedBytes: result.contentLength,
        },
      ),
    );
  });
  groups.public.post(`${base}/versions`, async (c) => {
    const auth = await principal(c);
    const body = await parseBody(DesktopVersionRequest, c);
    return c.json(await files.versions(auth.principal, body.paths, c.req.raw.signal));
  });
  if (groups.v2) {
    const v2 = groups.v2;
    const operationId = (c: Context) => {
      const parsed = CanonicalUuid.safeParse(c.req.param("id"));
      if (!parsed.success) throw new ApiHttpError("bad_request", "Invalid operation ID");
      return parsed.data;
    };
    v2.post(`${base}/pairings`, async (c) => {
      c.header("Cache-Control", "no-store");
      const body = await parseBody(DesktopPairRequest, c);
      return c.json(pairing.create(body.deviceName, deps.clientIp(c), 2), 201);
    });
    v2.post(`${base}/pairings/:id/poll`, async (c) => {
      c.header("Cache-Control", "no-store");
      const body = await parseBody(DesktopPairSecret, c);
      return c.json(await pairing.poll(c.req.param("id"), body.secret));
    });
    v2.post(`${base}/pairings/:id/cancel`, async (c) => {
      c.header("Cache-Control", "no-store");
      const body = await parseBody(DesktopPairSecret, c);
      await pairing.cancel(c.req.param("id"), body.secret);
      return c.json({ ok: true });
    });
    v2.post(`${base}/pairings/:id/confirm`, async (c) => {
      c.header("Cache-Control", "no-store");
      const body = await parseBody(DesktopPairSecret, c);
      await pairing.confirm(c.req.param("id"), body.secret);
      return c.json({ ok: true });
    });
    v2.get(`${base}/location`, async (c) =>
      c.json(await pairing.location((await principal(c, true)).principal, 2)),
    );
    v2.get(`${base}/entries`, async (c) => {
      const auth = await principal(c, true);
      return c.json(
        await writeService().list(
          auth.principal,
          path(c),
          hashApiToken(auth.bearer),
          c.req.query("cursor"),
        ),
      );
    });
    v2.post(`${base}/checks`, async (c) => {
      const auth = await principal(c, true);
      const body = await parseBody(DesktopFolderCheckRequest, c);
      return c.json(await writeService().check(auth.principal, body.folders, c.req.raw.signal));
    });
    v2.get(`${base}/changes`, async (c) => {
      const auth = await principal(c, true);
      if (!changes) throw new ApiHttpError("not_found", "This server keeps no change feed");
      const since = c.req.query("since");
      const parsed = DesktopChangeAnchor.optional().safeParse(since);
      if (!parsed.success) throw new ApiHttpError("bad_request", "Invalid change anchor");
      return c.json(await changes.read(auth.principal, parsed.data));
    });
    v2.get(`${base}/entry`, async (c) =>
      c.json(await writeService().stat((await principal(c, true)).principal, path(c))),
    );
    v2.get(`${base}/content`, async (c) => {
      const auth = await principal(c, true);
      const result = await writeService().files.content(auth.principal, path(c), c.req.raw.signal);
      c.header("Content-Type", "application/octet-stream");
      if (result.contentLength !== null) c.header("Content-Length", String(result.contentLength));
      return c.body(
        await activityStream(
          deps.activity,
          auth.principal,
          path(c),
          "file.materialize",
          result.body,
          {
            ...(hydrationId(c) ? { requestId: hydrationId(c) as string } : {}),
            expectedBytes: result.contentLength,
          },
        ),
      );
    });
    v2.post(`${base}/versions`, async (c) => {
      const auth = await principal(c, true);
      const body = await parseBody(DesktopVersionRequest, c);
      return c.json(
        await writeService().files.versions(auth.principal, body.paths, c.req.raw.signal),
      );
    });
    v2.post(`${base}/uploads`, async (c) => {
      const auth = await principal(c, true);
      const body = await parseBody(DesktopUploadRequest, c);
      return c.json(await writeService().prepare(auth.principal, { ...body, kind: "upload" }));
    });
    v2.post(`${base}/folders`, async (c) => {
      const auth = await principal(c, true);
      const body = await parseBody(DesktopFolderRequest, c);
      return c.json(await writeService().prepare(auth.principal, { ...body, kind: "folder" }));
    });
    v2.post(`${base}/moves`, async (c) => {
      const auth = await principal(c, true);
      const body = await parseBody(DesktopMoveRequest, c);
      return c.json(await writeService().prepare(auth.principal, { ...body, kind: "move" }));
    });
    v2.get(`${base}/operations/:id`, async (c) =>
      c.json(await writeService().status((await principal(c, true)).principal, operationId(c))),
    );
    v2.put(`${base}/operations/:id/content`, async (c) => {
      const auth = await principal(c, true);
      const body =
        c.req.raw.body ??
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        });
      return c.json(
        await writeService().upload(auth.principal, operationId(c), body, c.req.raw.signal),
      );
    });
    v2.post(`${base}/operations/:id/commit`, async (c) =>
      c.json(await writeService().commit((await principal(c, true)).principal, operationId(c))),
    );
    v2.post(`${base}/operations/:id/acknowledge`, async (c) =>
      c.json(
        await writeService().acknowledge((await principal(c, true)).principal, operationId(c)),
      ),
    );
    v2.post(`${base}/operations/:id/cancel`, async (c) =>
      c.json(await writeService().cancel((await principal(c, true)).principal, operationId(c))),
    );
    v2.post(`${base}/disconnect`, async (c) => {
      c.header("Cache-Control", "no-store");
      await pairing.revoke(c.req.header("authorization")?.replace(/^Bearer /, "") ?? "");
      return c.json({ ok: true });
    });
  }
  groups.public.post(`${base}/disconnect`, async (c) => {
    c.header("Cache-Control", "no-store");
    await pairing.revoke(c.req.header("authorization")?.replace(/^Bearer /, "") ?? "");
    return c.json({ ok: true });
  });
}
