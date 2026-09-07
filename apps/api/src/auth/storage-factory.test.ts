import { createSftpgoClient } from "@fdrive/sftpgo";
import { expect, it, vi } from "vitest";
import { ApiHttpError } from "../errors.js";
import { createIdentityStorageFactory } from "./storage-factory.ts";

it("captures client and identity for delayed reads/writes without retargeting", async () => {
  const requests: { host: string; authorization: string | null; method: string }[] = [];
  const fixed = (baseUrl: string) =>
    createSftpgoClient({
      baseUrl,
      fetch: async (url, init) => {
        requests.push({
          host: new URL(String(url)).host,
          authorization: new Headers(init?.headers).get("authorization"),
          method: init?.method ?? "GET",
        });
        return Response.json(init?.method === "DELETE" ? { message: "ok" } : []);
      },
    });
  const clientForIdentity = vi.fn().mockResolvedValue(fixed("http://a.test"));
  const tokenCalls: string[] = [];
  let tokenFailure: Error | null = null;
  const withToken = async <T>(
    identityId: string,
    fn: (token: string) => Promise<T>,
  ): Promise<T> => {
    tokenCalls.push(identityId);
    if (tokenFailure) throw tokenFailure;
    return fn("a-token");
  };
  const factory = createIdentityStorageFactory({ clientForIdentity, tokenSource: { withToken } });
  const storage = await factory("identity-a");
  clientForIdentity.mockResolvedValue(fixed("http://b.test"));
  await storage.list("/");
  await storage.deleteFile("/same.txt");
  expect(requests.map((request) => request.host)).toEqual(["a.test", "a.test"]);
  expect(requests.map((request) => request.authorization)).toEqual([
    "Bearer a-token",
    "Bearer a-token",
  ]);
  expect(tokenCalls).toEqual(["identity-a", "identity-a"]);
  expect(clientForIdentity).toHaveBeenCalledOnce();
  tokenFailure = new ApiHttpError("upstream_unavailable", "identity provider unavailable");
  await expect(storage.deleteFile("/later.txt")).rejects.toMatchObject({
    kind: "upstream_unavailable",
  });
  expect(requests).toHaveLength(2);
});
it("awaits binding and refuses an unresolved provider", async () => {
  const factory = createIdentityStorageFactory({
    clientForIdentity: async () => {
      throw new ApiHttpError("upstream_unavailable", "Unavailable");
    },
    tokenSource: { withToken: vi.fn() },
  });
  await expect(factory("identity-a")).rejects.toMatchObject({ kind: "upstream_unavailable" });
});
