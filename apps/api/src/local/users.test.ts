import { createMemoryRepos } from "@fdrive/db/testing";
import { describe, expect, it, vi } from "vitest";
import { FAST_PASSWORDS, seedLocalUsers } from "./test-fixtures/index.ts";
import { createLocalUserStore } from "./users.js";

async function fixture() {
  const repos = createMemoryRepos();
  await seedLocalUsers(repos, [
    { username: "Alice", password: "alice-pass" },
    { username: "bob", password: "bob-pass", disabled: true },
  ]);
  const passwords = { ...FAST_PASSWORDS, verify: vi.fn(FAST_PASSWORDS.verify) };
  const store = createLocalUserStore({
    repo: repos.localUsers,
    grants: repos.localGrants,
    passwords,
  });
  return { repos, passwords, store };
}

describe("createLocalUserStore: verify", () => {
  it("accepts the right password and reports the name as stored", async () => {
    const { store } = await fixture();
    expect(await store.verify("alice", "alice-pass")).toEqual({ result: "ok", username: "Alice" });
    expect(await store.verify("Alice", "wrong")).toEqual({ result: "invalid" });
  });

  it("tells a disabled user so only when the password is right", async () => {
    const { store } = await fixture();
    expect(await store.verify("bob", "bob-pass")).toEqual({ result: "disabled" });
    expect(await store.verify("bob", "guess")).toEqual({ result: "invalid" });
  });

  it("still checks a password for a name nobody has, against one cached decoy", async () => {
    const { store, passwords } = await fixture();
    expect(await store.verify("nobody", "alice-pass")).toEqual({ result: "invalid" });
    expect(await store.verify("nobody-else", "x")).toEqual({ result: "invalid" });
    expect(passwords.verify).toHaveBeenCalledTimes(2);
    const [first, second] = passwords.verify.mock.calls;
    expect(first?.[1]).toEqual(expect.stringMatching(/^scrypt\$/));
    // The decoy hash is made once and reused.
    expect(second?.[1]).toBe(first?.[1]);
  });
});

describe("createLocalUserStore: status and shared", () => {
  it("reports whether a user may use their files", async () => {
    const { store } = await fixture();
    expect(await store.status("ALICE")).toBe("active");
    expect(await store.status("bob")).toBe("disabled");
    expect(await store.status("carol")).toBe("missing");
  });

  it("lists what others share with a user, oldest first, with whether they may change it", async () => {
    const { repos, store } = await fixture();
    await seedLocalUsers(repos, [
      { username: "carol", password: "carol-pass" },
      { username: "dave", password: "dave-pass" },
    ]);
    await repos.localGrants.put({
      ownerUsername: "dave",
      path: "/Music",
      granteeUsername: "Alice",
      access: "write",
    });
    await repos.localGrants.put({
      ownerUsername: "bob",
      path: "/Projects",
      granteeUsername: "Alice",
      access: "write",
    });
    await repos.localGrants.put({
      ownerUsername: "carol",
      path: "/Photos/2026",
      granteeUsername: "Alice",
      access: "read",
    });
    // bob is disabled, so what he shares is gone with his sign-in.
    expect(await store.shared("Alice")).toEqual([
      { owner: "dave", path: "/Music", writable: true },
      { owner: "carol", path: "/Photos/2026", writable: false },
    ]);
    expect(await store.shared("bob")).toEqual([]);
  });
});
