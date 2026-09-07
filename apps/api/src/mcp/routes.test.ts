import { describe, expect, it } from "vitest";
import { withMcpResponseHeaders } from "./routes.js";

describe("withMcpResponseHeaders", () => {
  it("sets Cache-Control: no-store and Referrer-Policy: no-referrer", () => {
    const response = new Response("body", { status: 200 });

    const result = withMcpResponseHeaders(response);

    expect(result.headers.get("Cache-Control")).toBe("no-store");
    expect(result.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("preserves the status, status text, and body of the original response", async () => {
    const response = new Response("hello", {
      status: 201,
      statusText: "Created",
      headers: { "content-type": "text/plain" },
    });

    const result = withMcpResponseHeaders(response);

    expect(result.status).toBe(201);
    expect(result.statusText).toBe("Created");
    expect(await result.text()).toBe("hello");
  });

  it("keeps every header the original response already set", () => {
    const response = new Response(null, {
      status: 200,
      headers: { "x-custom": "value", "content-type": "application/json" },
    });

    const result = withMcpResponseHeaders(response);

    expect(result.headers.get("x-custom")).toBe("value");
    expect(result.headers.get("content-type")).toBe("application/json");
  });

  it("overwrites a pre-existing Cache-Control or Referrer-Policy header", () => {
    const response = new Response(null, {
      status: 200,
      headers: { "Cache-Control": "max-age=60", "Referrer-Policy": "origin" },
    });

    const result = withMcpResponseHeaders(response);

    expect(result.headers.get("Cache-Control")).toBe("no-store");
    expect(result.headers.get("Referrer-Policy")).toBe("no-referrer");
  });
});
