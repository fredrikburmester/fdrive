import { describe, expect, it } from "vitest";
import { createMemoryRepos } from "../src/testing/memory-repos.js";
import { defineReposSuite } from "./repos-suite.js";

defineReposSuite("memory", () => createMemoryRepos());

describe("createMemoryRepos ids option", () => {
  it("uses the supplied id generator instead of a random uuid", async () => {
    let counter = 0;
    const repos = createMemoryRepos({ ids: () => `id-${++counter}` });

    const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl: "http://x" });
    const account = await repos.accounts.create({ displayName: null });

    expect(provider.id).toBe("id-1");
    expect(account.id).toBe("id-2");
  });
});
