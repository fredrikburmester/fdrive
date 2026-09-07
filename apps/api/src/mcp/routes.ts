import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Context } from "hono";
import type { AppHono } from "../app.js";
import { type McpAuthDeps, resolveMcpPrincipal } from "./auth.js";
import type { McpToolDeps } from "./handlers.js";
import { registerMcpTools } from "./tools.js";

const SERVER_INFO = { name: "fdrive", version: "0.1.0" };

const SERVER_INSTRUCTIONS =
  "Search and browse the user's fdrive share. Paths are virtual paths from the share root, e.g. " +
  '"/Documents/Work/Contracts/agreement.pdf". Use `search` for content or topic questions, ' +
  "`find_files` for names/dates/types/sizes, `read_file_text` to read a document, " +
  "`find_duplicates` and `folder_overview` when helping organize. Always give the `url` back to " +
  "the user so they can open the file in fdrive. Write tools (`create_folder`, `move_path`) may " +
  "be disabled; if so, tell the user rather than retrying.";

export interface McpRoutesDeps extends McpAuthDeps {
  readonly toolDeps: McpToolDeps;
}

async function handleMcpRequest(c: Context, deps: McpRoutesDeps): Promise<Response> {
  const principal = await resolveMcpPrincipal(c, deps);
  if (principal === null) {
    return withMcpResponseHeaders(Response.json({ error: "unauthorized" }, { status: 401 }));
  }

  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });
  registerMcpTools(server, principal, deps.toolDeps);

  // A fresh server and transport per request: the SDK's documented pattern
  // for a stateless streamable-HTTP MCP server (PLAN.md §7 calls for
  // "stateless, JSON responses").
  // Omitting `sessionIdGenerator` (rather than setting it to `undefined`)
  // is what puts the transport in stateless mode per its own docs.
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  await server.connect(transport);

  const response = await transport.handleRequest(c.req.raw);
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
