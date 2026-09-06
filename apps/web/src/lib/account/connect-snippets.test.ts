import { describe, expect, it } from "vitest";
import { claudeMcpAddCommand, connectorUrl } from "./connect-snippets";

describe("claudeMcpAddCommand", () => {
  it("builds the claude mcp add command with the public url and token", () => {
    expect(claudeMcpAddCommand("https://fdrive.example.com", "fdr_abc123")).toBe(
      'claude mcp add --transport http fdrive https://fdrive.example.com/mcp --header "Authorization: Bearer fdr_abc123"',
    );
  });
});

describe("connectorUrl", () => {
  it("builds the token-in-path connector url", () => {
    expect(connectorUrl("https://fdrive.example.com", "fdr_abc123")).toBe(
      "https://fdrive.example.com/mcp/t/fdr_abc123",
    );
  });
});
