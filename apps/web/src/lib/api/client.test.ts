import { describe, expect, it } from "vitest";
import { apiClient } from "./client.ts";

describe("apiClient", () => {
  it("is a fully built ApiClient with a same-origin base URL", () => {
    expect(typeof apiClient.me).toBe("function");
    expect(typeof apiClient.login).toBe("function");
    expect(apiClient.downloadUrl("/a.txt")).toBe("/api/v1/fs/download?path=%2Fa.txt");
  });
});

it("pins requests and native URLs independently of another tab's cookie selection", async () => {
  const { createTabApiClient } = await import("./client");
  const requests: Array<{ path: string; identity: string | null }> = [];
  let cookieIdentity = "one";
  const fetchImpl: typeof fetch = async (url, init) => {
    const identity = new Headers(init?.headers).get("x-identity-id");
    requests.push({ path: String(url), identity });
    const owner = identity ?? cookieIdentity;
    if (String(url).includes("rename"))
      return Response.json({
        name: "renamed",
        path: "/renamed",
        kind: "file",
        size: 1,
        modifiedAt: "2026-01-01T00:00:00Z",
        ext: "",
        mime: null,
      });
    return Response.json({ ok: true, owner });
  };
  const tabA = createTabApiClient({ fetch: fetchImpl });
  const tabB = createTabApiClient({ fetch: fetchImpl });
  tabA.pinIdentity("one");
  tabB.pinIdentity("two");
  cookieIdentity = "two";
  await tabA.client.remove([{ path: "/same", kind: "file" }]);
  await tabA.client.rename("/same", "renamed");
  expect(requests.map((request) => request.identity)).toEqual(["one", "one"]);
  expect(tabA.client.downloadUrl("/same", { inline: true })).toContain("identity=one");
  expect(tabA.client.thumbUrl("/same", 256)).toBe(
    "/api/v1/thumb?path=%2Fsame&size=256&identity=one",
  );
  expect(tabB.client.downloadUrl("/same")).toContain("identity=two");
  const captured = tabA.snapshot();
  tabA.pinIdentity("two");
  await captured.remove([{ path: "/later", kind: "file" }]);
  expect(requests.at(-1)?.identity).toBe("one");
});

it("never falls back after an identity becomes unlinked and leaves login/logout unscoped", async () => {
  const { createTabApiClient } = await import("./client");
  const owners: Array<string | null> = [];
  const tab = createTabApiClient({
    baseUrl: "https://fdrive.example",
    fetch: async (_url, init) => {
      owners.push(new Headers(init?.headers).get("x-identity-id"));
      return Response.json({ error: { kind: "forbidden", message: "not owned" } }, { status: 403 });
    },
  });
  tab.pinIdentity("removed");
  await expect(tab.client.remove([{ path: "/same", kind: "file" }])).rejects.toHaveProperty(
    "status",
    403,
  );
  await expect(tab.client.me()).rejects.toHaveProperty("status", 403);
  expect(owners).toEqual(["removed", "removed"]);
  await expect(
    tab.client.login({ credential: { username: "a", password: "test" } }),
  ).rejects.toHaveProperty("status", 403);
  await expect(tab.client.logout()).rejects.toHaveProperty("status", 403);
  expect(owners.slice(2)).toEqual([null, null]);
  tab.pinIdentity(undefined);
  expect(tab.getIdentity()).toBeUndefined();
  expect(tab.client.thumbUrl("/same", 256)).not.toContain("identity=");
});

it("does not pin shared server state and exposes a captured same-origin client", async () => {
  const { getTabIdentity, pinTabIdentity, snapshotTabApiClient, tabEventsUrl } = await import(
    "./client"
  );
  pinTabIdentity("server-request");
  expect(getTabIdentity()).toBeUndefined();
  expect(snapshotTabApiClient().downloadUrl("/a")).toBe("/api/v1/fs/download?path=%2Fa");
  expect(tabEventsUrl()).toBe("/api/v1/events");
});
