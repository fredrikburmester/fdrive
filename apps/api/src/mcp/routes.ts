import { createHash, randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Context } from "hono";
import { activityStorage } from "../activity/storage.js";
import type { AppHono } from "../app.js";
import { trashPathFor } from "./access.js";
import { authenticateMcpRequest, type McpAuthDeps } from "./auth.js";
import { boundedBytes } from "./content.ts";
import type { McpToolDeps } from "./handlers.js";
import { registerMcpTools } from "./tools.js";

const SERVER_INFO = { name: "fdrive", version: "0.1.0" };
// Allows a 4 MiB text payload even when JSON escapes every character.
export const MAX_MCP_REQUEST_BYTES = 32 * 1024 * 1024;

const SERVER_INSTRUCTIONS =
  "Search and browse the user's fdrive share. Paths are virtual paths from the share root, e.g. " +
  '"/Documents/Work/Contracts/agreement.pdf". Use `search` for content or topic questions, ' +
  "`find_files` for names/dates/types/sizes, `read_file_text` to read a document, " +
  "`find_duplicates` and `folder_overview` when helping organize. Always give the `url` back to " +
  "the user so they can open the file in fdrive. Use `capabilities` for token permissions and " +
  "optional processing status. Stay within allowed folders. For edits, read first and pass the " +
  "returned SHA-256. Completed writes may include metadata warnings; do not repeat the write.";

export interface McpRoutesDeps extends McpAuthDeps {
  readonly toolDeps: McpToolDeps;
}

async function handleMcpRequest(c: Context, deps: McpRoutesDeps): Promise<Response> {
  const auth = await authenticateMcpRequest(c, deps);
  if (auth.kind === "rate_limited") {
    // Never advertise an immediate retry: the limiter reports no delay when
    // it is at capacity rather than blocking a known address.
    const retryAfterSeconds = Math.max(1, Math.ceil(auth.retryAfterMs / 1000));
    return withMcpResponseHeaders(
      Response.json(
        { error: "rate_limited" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      ),
    );
  }
  if (auth.kind === "unauthorized") {
    return withMcpResponseHeaders(Response.json({ error: "unauthorized" }, { status: 401 }));
  }

  let parsedBody: unknown;
  if (c.req.method === "POST" && c.req.raw.body !== null) {
    if (Number(c.req.header("content-length")) > MAX_MCP_REQUEST_BYTES) {
      await c.req.raw.body.cancel();
      return withMcpResponseHeaders(Response.json({ error: "request too large" }, { status: 413 }));
    }
    let bytes: Buffer;
    try {
      bytes = await boundedBytes(c.req.raw.body, MAX_MCP_REQUEST_BYTES);
    } catch {
      return withMcpResponseHeaders(
        Response.json({ error: "request too large or interrupted" }, { status: 413 }),
      );
    }
    try {
      parsedBody = JSON.parse(bytes.toString("utf8"));
    } catch {
      return withMcpResponseHeaders(Response.json({ error: "invalid JSON" }, { status: 400 }));
    }
  }

  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });
  const requestId = c.req.header("x-fdrive-operation-id");
  if (requestId && !/^[a-zA-Z0-9:_-]{1,200}$/.test(requestId))
    return withMcpResponseHeaders(
      Response.json({ error: "invalid operation ID" }, { status: 400 }),
    );
  // The credential identifies the caller across requests, so repeated reads by
  // one token aggregate together. It is hashed: no token text reaches history.
  const operationId = requestId ?? randomUUID();
  const credential = c.req.header("authorization") ?? c.req.param("token") ?? operationId;
  const context = createHash("sha256").update(credential).digest("hex");
  const tool = (parsedBody as { params?: { name?: string } } | undefined)?.params?.name;
  let principal = auth.principal;
  let child = 0;
  if (deps.toolDeps.activity)
    principal = {
      ...principal,
      storage: activityStorage(
        principal,
        deps.toolDeps.activity,
        () => ({
          source: "mcp",
          operationId: `${context}:${operationId}:${child++}`,
          uploadAction:
            tool === "edit_file"
              ? "file.save"
              : tool === "upload_file"
                ? "file.upload"
                : "file.create",
        }),
        trashPathFor(deps.toolDeps, principal),
      ),
    };
  registerMcpTools(server, principal, {
    ...deps.toolDeps,
    activityContext: context,
    activityRequestId: operationId,
  });

  // A fresh server and transport per request: the SDK's documented pattern
  // for a stateless streamable-HTTP MCP server with JSON responses.
  // Omitting `sessionIdGenerator` (rather than setting it to `undefined`)
  // is what puts the transport in stateless mode per its own docs.
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  await server.connect(transport);

  const response = await transport.handleRequest(c.req.raw, { parsedBody });
  return withMcpResponseHeaders(response);
}

/**
 * Adds `Cache-Control: no-store` (never cache a response that may embed
 * tool output derived from the caller's files) and `Referrer-Policy:
 * no-referrer` (never leak the `/mcp/t/:token` URL, itself a secret, to a
 * downstream `Referer`) to an MCP response, without altering its body,
 * status, or any header the transport already set.
 */
export function withMcpResponseHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Mounts the MCP endpoint outside `/api/v1`, at `POST|GET|DELETE /mcp` and,
 * for clients that cannot set headers (claude.ai connectors), the same
 * methods under `/mcp/t/:token`. The CSRF guard in `app.ts` only applies to
 * `/api/v1/*`, so it never runs here; these routes are bearer- (or
 * path-token-) authenticated instead. The `/mcp/t/:token` URL is itself a
 * secret: anyone who has it can act as the token's identity, so it should
 * be handled with the same care as the bearer token itself.
 *
 * Nothing else guards these routes, so `authenticateMcpRequest` also carries
 * their abuse budget: a malformed credential is refused without a lookup,
 * and repeated failed lookups from one address are answered `429` with
 * `Retry-After` instead of another one.
 */
export function registerMcpRoutes(app: AppHono, deps: McpRoutesDeps): void {
  const handler = (c: Context) => handleMcpRequest(c, deps);

  app.post("/mcp", handler);
  app.get("/mcp", handler);
  app.delete("/mcp", handler);

  app.post("/mcp/t/:token", handler);
  app.get("/mcp/t/:token", handler);
  app.delete("/mcp/t/:token", handler);
}
