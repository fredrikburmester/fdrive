import {
  DESKTOP_API,
  DesktopPairApproval,
  DesktopPairRequest,
  DesktopPairSecret,
  DesktopPath,
  DesktopVersionRequest,
} from "@fdrive/contracts";
import type { Context } from "hono";
import { accountContext } from "../accounts/routes.js";
import type { AppHono, AuthedHono } from "../app.js";
import type { Principal } from "../auth/principal.js";
import { ApiHttpError } from "../errors.js";
import { parseBody } from "../fs/routes.js";
import { hashApiToken } from "../tokens/token-format.js";
import { createDesktopFiles } from "./files.js";
import { createDesktopPairing, type DesktopDeps } from "./pairing.js";

export function registerDesktopRoutes(
  groups: { public: AppHono; authed: AuthedHono },
  deps: DesktopDeps & { clientIp: (c: Context) => string },
) {
  const base = DESKTOP_API.slice("/api/v1".length);
  const pairing = createDesktopPairing(deps);
  const files = createDesktopFiles(deps);
  function path(c: Context) {
    const parsed = DesktopPath.safeParse(c.req.query("path"));
    if (!parsed.success) throw new ApiHttpError("bad_request", "Invalid file path");
    return parsed.data;
  }
  async function principal(c: Context): Promise<{ bearer: string; principal: Principal }> {
    c.header("Cache-Control", "no-store");
    const bearer = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
    const resolved = await pairing.resolve(bearer);
    if (resolved?.tokenAccess?.mode !== "read")
      throw new ApiHttpError("unauthorized", "Reconnect this location in the Mac app");
    return { bearer, principal: resolved };
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
  groups.authed.get(`${base}/pairings/:id`, (c) => {
    accountContext(c);
    return c.json(pairing.info(c.req.param("id")));
  });
  groups.authed.post(`${base}/pairings/:id/approve`, async (c) => {
    const owner = accountContext(c);
    const body = await parseBody(DesktopPairApproval, c);
    await pairing.approve(c.req.param("id"), owner.principal.accountId, body.identityIds);
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
  groups.public.post(`${base}/disconnect`, async (c) => {
    c.header("Cache-Control", "no-store");
    await pairing.revoke(c.req.header("authorization")?.replace(/^Bearer /, "") ?? "");
    return c.json({ ok: true });
  });
}
