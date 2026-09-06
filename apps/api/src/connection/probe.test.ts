import { describe, expect, it, vi } from "vitest";
import { probeConnection } from "./probe.js";

function textResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

describe("probeConnection", () => {
  it("succeeds when /healthz returns ok and the token endpoint returns 401", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textResponse(200, "ok"))
      .mockResolvedValueOnce(textResponse(401, "unauthorized"));

    const result = await probeConnection("http://sftpgo:8080", { fetch: fetchImpl });

    expect(result).toEqual({ ok: true, detail: "SFTPGo is reachable" });
    expect(fetchImpl).toHaveBeenNthCalledWith(1, "http://sftpgo:8080/healthz");
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "http://sftpgo:8080/api/v2/user/token");
  });

  it("strips a trailing slash before joining paths", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textResponse(200, "ok"))
      .mockResolvedValueOnce(textResponse(401, "unauthorized"));

    await probeConnection("http://sftpgo:8080/", { fetch: fetchImpl });

    expect(fetchImpl).toHaveBeenNthCalledWith(1, "http://sftpgo:8080/healthz");
  });

  it("trims whitespace around the healthz body", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textResponse(200, "ok\n"))
      .mockResolvedValueOnce(textResponse(401, "unauthorized"));

    const result = await probeConnection("http://sftpgo:8080", { fetch: fetchImpl });

    expect(result.ok).toBe(true);
  });

  it("fails when /healthz cannot be reached", async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error("connection refused"));

    const result = await probeConnection("http://sftpgo:8080", { fetch: fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("connection refused");
  });

  it("fails when /healthz rejects with a non-Error value", async () => {
    // Exercises the non-Error rejection branch: real fetch rejections are
    // always Error instances, but nothing stops another fetch-like
    // implementation from rejecting with something else.
    const fetchImpl = vi.fn().mockRejectedValueOnce("boom");

    const result = await probeConnection("http://sftpgo:8080", { fetch: fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("network error");
  });

  it("fails when /healthz returns a non-200 status", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(textResponse(500, "boom"));

    const result = await probeConnection("http://sftpgo:8080", { fetch: fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("500");
  });

  it("fails when /healthz returns an unexpected body", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(textResponse(200, "not ok"));

    const result = await probeConnection("http://sftpgo:8080", { fetch: fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('"ok"');
  });

  it("fails when the token endpoint cannot be reached", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textResponse(200, "ok"))
      .mockRejectedValueOnce(new Error("timeout"));

    const result = await probeConnection("http://sftpgo:8080", { fetch: fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("timeout");
  });

  it("fails when the token endpoint does not return 401", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textResponse(200, "ok"))
      .mockResolvedValueOnce(textResponse(200, "unexpected"));

    const result = await probeConnection("http://sftpgo:8080", { fetch: fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("200");
  });
});
