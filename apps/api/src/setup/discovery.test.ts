import { describe, expect, it, vi } from "vitest";
import { discoverSftpgoUsers } from "./discovery.js";

const input = {
  baseUrl: "http://sftpgo:8080",
  username: "admin",
  password: "correct-horse",
  limit: 2,
  offset: 0,
};

describe("discoverSftpgoUsers", () => {
  it("uses ephemeral credentials and redacts the upstream user payload", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "admin-jwt" })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { username: "alice", status: 1, home_dir: "/private/alice", password: "never" },
            { username: "disabled", status: 0, filters: { secrets: ["never"] } },
          ]),
        ),
      );

    await expect(discoverSftpgoUsers(input, { fetch })).resolves.toEqual({
      ok: true,
      users: [
        { username: "alice", status: "enabled" },
        { username: "disabled", status: "disabled" },
      ],
      nextOffset: 2,
    });
    expect(fetch.mock.calls[0]?.[0]).toBe("http://sftpgo:8080/api/v2/token");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
    expect(fetch.mock.calls[1]?.[0]).toContain("/api/v2/users?limit=2&offset=0");
    expect(JSON.stringify(fetch.mock.calls[1]?.[1])).not.toContain("correct-horse");
  });

  it("reports denied inventory without leaking a raw denial response", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response("admin credentials invalid", { status: 403 }));

    await expect(discoverSftpgoUsers(input, { fetch })).resolves.toEqual({
      ok: false,
      reason: "denied",
    });
  });

  it("bounds an upstream response that ignores the requested page limit", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "admin-jwt" })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { username: "alice", status: 1 },
            { username: "bob", status: 1 },
            { username: "ignored", status: 1 },
          ]),
        ),
      );

    await expect(discoverSftpgoUsers(input, { fetch })).resolves.toEqual({
      ok: true,
      users: [
        { username: "alice", status: "enabled" },
        { username: "bob", status: "enabled" },
      ],
      nextOffset: 2,
    });
  });

  it("rejects an oversized upstream body before parsing it", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response("x".repeat(16 * 1024 + 1), {
        headers: { "content-length": String(16 * 1024 + 1) },
      }),
    );

    await expect(discoverSftpgoUsers(input, { fetch })).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("cancels a streaming body that exceeds its byte limit", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("x".repeat(16 * 1024 + 1)));

    await expect(discoverSftpgoUsers(input, { fetch })).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["token transport failure", vi.fn().mockRejectedValue(new Error("offline"))],
    ["token server failure", vi.fn().mockResolvedValue(new Response("oops", { status: 500 }))],
    [
      "malformed token response",
      vi.fn().mockResolvedValue(new Response("not json", { status: 200 })),
    ],
    [
      "missing access token",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ token: "missing" }))),
    ],
  ])("returns unavailable for %s", async (_name, fetch) => {
    await expect(discoverSftpgoUsers(input, { fetch })).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it.each([
    ["transport failure", vi.fn().mockRejectedValue(new Error("offline")), "unavailable"],
    [
      "server failure",
      vi.fn().mockResolvedValue(new Response("oops", { status: 500 })),
      "unavailable",
    ],
    ["access denied", vi.fn().mockResolvedValue(new Response("no", { status: 401 })), "denied"],
    ["malformed body", vi.fn().mockResolvedValue(new Response("not json")), "unavailable"],
    [
      "unexpected body",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ users: "no" }))),
      "unavailable",
    ],
  ])("returns %s safely when users request has %s", async (_name, usersResponse, reason) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "admin-jwt" })))
      .mockImplementationOnce(usersResponse);

    await expect(discoverSftpgoUsers(input, { fetch })).resolves.toEqual({ ok: false, reason });
  });

  it("drops invalid upstream usernames from the returned page", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "admin-jwt" })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { username: "", status: 1 },
            { username: "x".repeat(256), status: 1 },
            { username: "valid", status: "enabled" },
          ]),
        ),
      );

    await expect(discoverSftpgoUsers({ ...input, limit: 3 }, { fetch })).resolves.toEqual({
      ok: true,
      users: [{ username: "valid", status: "enabled" }],
      nextOffset: 3,
    });
  });
});
