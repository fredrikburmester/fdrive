import { describe, expect, it, vi } from "vitest";
import { createScopeResolver } from "./resolver.ts";

type Received = { owner: string; path: string; name: string };

function resolver(received: readonly Received[] = []) {
  const lookup = vi.fn(async (_username: string) => received);
  return { lookup, scopes: createScopeResolver({ received: lookup }) };
}

describe("scopesFor", () => {
  it("maps the login's home to its folder in the files folder", async () => {
    const { scopes, lookup } = resolver();
    expect(await scopes.scopesFor("alice")).toEqual([{ fsPrefix: "/alice", virtualPrefix: "/" }]);
    expect(lookup).toHaveBeenCalledWith("alice");
  });

  it("adds each folder shared with the login under Shared with me, after the home", async () => {
    const { scopes } = resolver([
      { owner: "bob", path: "/Photos", name: "Photos" },
      { owner: "carol", path: "/", name: "carol" },
    ]);
    expect(await scopes.scopesFor("alice")).toEqual([
      { fsPrefix: "/alice", virtualPrefix: "/" },
      { fsPrefix: "/bob/Photos", virtualPrefix: "/Shared with me/Photos" },
      { fsPrefix: "/carol", virtualPrefix: "/Shared with me/carol" },
    ]);
  });

  it("refuses a username that cannot name one folder, asking for nothing", async () => {
    const { scopes, lookup } = resolver();
    for (const username of ["..", "a/b", ""]) {
      await expect(scopes.scopesFor(username)).rejects.toMatchObject({ kind: "forbidden" });
    }
    expect(lookup).not.toHaveBeenCalled();
  });
});
