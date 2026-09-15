import {
  CanonicalUuid,
  DESKTOP_API,
  DesktopFolderRequest,
  DesktopMoveRequest,
  DesktopPairApproval,
  DesktopPairRequest,
  DesktopPairSecret,
  DesktopPath,
  DesktopRecoveryResolution,
  DesktopRecoveryResponse,
  DesktopUploadRequest,
  DesktopVersionRequest,
} from "@fdrive/contracts";
import type { DesktopEffectsRepo } from "@fdrive/db";
import type { Context } from "hono";
import { accountContext } from "../accounts/routes.js";
import type { AppHono, AuthedHono } from "../app.js";
import { createRequireAdmin, type Principal } from "../auth/principal.js";
import { ApiHttpError } from "../errors.js";
import { parseBody } from "../fs/routes.js";
import { hashApiToken } from "../tokens/token-format.js";
import { createDesktopFiles } from "./files.js";
import { createDesktopPairing, type DesktopDeps } from "./pairing.js";
import { publishesSafely } from "./publish-gate.js";
import type { DesktopWrites } from "./writes.js";

export function registerDesktopRoutes(
  groups: { public: AppHono; authed: AuthedHono; v2?: AppHono },
  deps: DesktopDeps & {
    clientIp: (c: Context) => string;
    writes?: DesktopWrites;
    recovery?: Pick<DesktopEffectsRepo, "status">;
  },
) {
  const base = DESKTOP_API.slice("/api/v1".length);
  const writes = deps.writes;
  const writeService = () => {
    if (!deps.writes) throw new ApiHttpError("not_found", "Desktop writes are unavailable");
    return deps.writes;
  };
  groups.authed.get(`${base}/recovery`, createRequireAdmin(), async (c) => {
    c.header("Cache-Control", "no-store");
    if (!deps.recovery)
      throw new ApiHttpError("upstream_unavailable", "Recovery status is unavailable");
    const pending = await deps.recovery.status();
    return c.json(
      DesktopRecoveryResponse.parse({
        pending: pending.map((job) => ({
          ...job,
          createdAt: job.createdAt.toISOString(),
          nextAttemptAt: job.nextAttemptAt.toISOString(),
        })),
        uncertain: writes ? await writes.uncertain(deps.clock()) : [],
      }),
    );
  });
  groups.authed.post(
    `${base}/recovery/:identityId/:operationId/resolve`,
    createRequireAdmin(),
    async (c) => {
      c.header("Cache-Control", "no-store");
      const body = await parseBody(DesktopRecoveryResolution, c);
      const identityId = CanonicalUuid.safeParse(c.req.param("identityId"));
      const operationId = CanonicalUuid.safeParse(c.req.param("operationId"));
      if (!identityId.success || !operationId.success)
        throw new ApiHttpError("bad_request", "Invalid recovery reference");
      const identity = await deps.identities.get(identityId.data);
      if (!identity) throw new ApiHttpError("not_found", "Storage login no longer exists");
      return c.json(
        await writeService().resolve(
          identity.id,
          identity.accountId,
          operationId.data,
          body.outcome,
          deps.clock(),
        ),
      );
    },
  );
  const pairing = createDesktopPairing({
    ...deps,
    ...(writes
      ? { writeCapabilities: async (principal: Principal) => writes.capabilities(principal) }
      : {}),
  });
  const files = createDesktopFiles(deps);
  function path(c: Context) {
    const parsed = DesktopPath.safeParse(c.req.query("path"));
    if (!parsed.success) throw new ApiHttpError("bad_request", "Invalid file path");
    return parsed.data;
  }
  async function principal(
    c: Context,
    writeProtocol = false,
  ): Promise<{ bearer: string; principal: Principal }> {
    c.header("Cache-Control", "no-store");
    const bearer = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
    const resolved = await pairing.resolve(bearer);
    if (
      !resolved ||
      (resolved.tokenAccess?.mode !== "read" &&
        !(writeProtocol && resolved.tokenAccess?.mode === "full"))
    )
      throw new ApiHttpError("unauthorized", "Reconnect this location in the Mac app");
    return {
      bearer,
      principal: {
        ...resolved,
        verifyAuthority: async () => {
          const fresh = await pairing.resolve(bearer);
          return (
            fresh !== null &&
            fresh.accountId === resolved.accountId &&
            fresh.identityId === resolved.identityId &&
            JSON.stringify(fresh.tokenAccess) === JSON.stringify(resolved.tokenAccess) &&
            (!writeProtocol || publishesSafely(fresh.storage, deps.publishLock !== undefined))
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
    const owner = accountContext(c);
    const body = await parseBody(DesktopPairApproval, c);
    await pairing.approve(
      c.req.param("id"),
      owner.principal.accountId,
      body.identityIds,
      body.access,
    );
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
    return c.body(result.body);
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
    v2.get(`${base}/entry`, async (c) =>
      c.json(await writeService().stat((await principal(c, true)).principal, path(c))),
    );
    v2.get(`${base}/content`, async (c) => {
      const auth = await principal(c, true);
      const result = await writeService().files.content(auth.principal, path(c), c.req.raw.signal);
      c.header("Content-Type", "application/octet-stream");
      if (result.contentLength !== null) c.header("Content-Length", String(result.contentLength));
      return c.body(result.body);
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
