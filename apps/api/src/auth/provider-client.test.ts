import { createMemoryRepos } from "@fdrive/db/testing";
import { createSftpgoClient } from "@fdrive/sftpgo";
import { describe, expect, it, vi } from "vitest";
import type { Connection } from "../connection/store.js";
import { createIdentityClientResolver, requireCurrentConnection } from "./provider-client.ts";

async function fixture(type = "sftpgo") {
  const repos = createMemoryRepos();
  const provider = await repos.providers.ensure({ type, baseUrl: "http://a.test" });
  const account = await repos.accounts.create({ displayName: "Alice" });
  const identity = await repos.identities.create({
    providerId: provider.id,
    accountId: account.id,
    externalUsername: "alice",
  });
  let connection: Connection | null = {
    baseUrl: provider.baseUrl,
    homeTemplate: "sftpgo:/{username}",
    source: "settings",
  };
  const connections = { current: vi.fn(async () => connection) };
  const requests: string[] = [];
  const clientForBaseUrl = vi.fn((baseUrl: string) =>
    createSftpgoClient({
      baseUrl,
      fetch: async (url) => {
        requests.push(String(url));
        return Response.json([]);
      },
    }),
  );
  const resolve = createIdentityClientResolver({ ...repos, connections, clientForBaseUrl });
  return {
    repos,
    provider,
    identity,
    connections,
    requests,
    clientForBaseUrl,
    resolve,
    switchTo: (value: Connection | null) => {
      connection = value;
    },
  };
}
describe("identity provider binding", () => {
  it("returns a fixed client that never follows later configuration changes", async () => {
    const h = await fixture();
    const client = await h.resolve(h.identity.id);
    h.switchTo({
      baseUrl: "http://b.test",
      homeTemplate: "sftpgo:/{username}",
      source: "settings",
    });
    await client.user("a-token").list("/");
    expect(h.requests).toHaveLength(1);
    expect(new URL(h.requests[0] ?? "").origin).toBe("http://a.test");
    await expect(h.resolve(h.identity.id)).rejects.toMatchObject({ kind: "upstream_unavailable" });
    expect(h.clientForBaseUrl).toHaveBeenCalledTimes(1);
  });
  it("rejects missing identities/providers and unsupported provider types before creating clients", async () => {
    const h = await fixture();
    await expect(h.resolve("missing")).rejects.toMatchObject({ kind: "reauth_required" });
    vi.spyOn(h.repos.providers, "get").mockResolvedValue(null);
    await expect(h.resolve(h.identity.id)).rejects.toMatchObject({ kind: "upstream_unavailable" });
    expect(h.clientForBaseUrl).not.toHaveBeenCalled();
    const other = await fixture("webdav");
    await expect(other.resolve(other.identity.id)).rejects.toMatchObject({
      kind: "upstream_unavailable",
    });
    expect(other.clientForBaseUrl).not.toHaveBeenCalled();
  });
  it("requires exact URL equality, including when setup is missing", async () => {
    const h = await fixture();
    await expect(requireCurrentConnection(h.connections, "http://a.test")).resolves.toBeUndefined();
    for (const url of ["http://a.test/", "https://a.test", "http://b.test"])
      await expect(requireCurrentConnection(h.connections, url)).rejects.toMatchObject({
        kind: "upstream_unavailable",
      });
    h.switchTo(null);
    await expect(h.resolve(h.identity.id)).rejects.toMatchObject({ kind: "upstream_unavailable" });
    expect(h.clientForBaseUrl).not.toHaveBeenCalled();
  });
});
