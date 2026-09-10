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
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "http://sftpgo:8080/healthz",
      expect.objectContaining({ redirect: "error" }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "http://sftpgo:8080/api/v2/user/token",
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("strips a trailing slash before joining paths", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textResponse(200, "ok"))
      .mockResolvedValueOnce(textResponse(401, "unauthorized"));

    await probeConnection("http://sftpgo:8080/", { fetch: fetchImpl });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "http://sftpgo:8080/healthz",
      expect.objectContaining({ redirect: "error" }),
    );
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

  it("bounds the health response before reading it", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(textResponse(200, "x".repeat(1025)));

    const result = await probeConnection("http://sftpgo:8080", { fetch: fetchImpl });

    expect(result).toEqual({
      ok: false,
      detail: "GET /healthz response could not be read safely",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails safely when reading the health response fails", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("read failed");
      },
    });
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(body));

    await expect(probeConnection("http://sftpgo:8080", { fetch: fetchImpl })).resolves.toEqual({
      ok: false,
      detail: "GET /healthz response could not be read safely",
    });
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

  it.each([
    ["http://user:password@sftpgo:8080", "credentials"],
    ["http://169.254.169.254", "metadata"],
    ["http://metadata.google.internal", "metadata"],
    ["ssh://sftpgo:22", "http or https"],
    ["not a URL", "invalid"],
  ])("rejects unsafe candidate %s", async (baseUrl, detail) => {
    const fetchImpl = vi.fn();

    const result = await probeConnection(baseUrl, { fetch: fetchImpl });

    expect(result).toMatchObject({ ok: false });
    expect(result.detail).toContain(detail);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("permits private-LAN SFTPGo URLs", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textResponse(200, "ok"))
      .mockResolvedValueOnce(textResponse(401, "unauthorized"));

    await expect(
      probeConnection("http://192.168.1.40:8080", { fetch: fetchImpl }),
    ).resolves.toMatchObject({
      ok: true,
    });
  });
});
