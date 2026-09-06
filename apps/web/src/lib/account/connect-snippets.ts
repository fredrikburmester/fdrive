/**
 * The `claude` CLI command that adds fdrive's MCP server with a bearer
 * token, shown on the account page's "Connect Claude" snippet.
 */
export function claudeMcpAddCommand(publicUrl: string, token: string): string {
  return `claude mcp add --transport http fdrive ${publicUrl}/mcp --header "Authorization: Bearer ${token}"`;
}

/**
 * The claude.ai connector URL form: a token-in-path URL, for clients (such
 * as claude.ai's web connectors) that cannot set a custom header. This URL
 * is itself a secret, equivalent to sharing the bearer token.
 */
export function connectorUrl(publicUrl: string, token: string): string {
  return `${publicUrl}/mcp/t/${token}`;
}
