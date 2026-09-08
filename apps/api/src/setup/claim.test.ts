import { createMemoryRepos } from "@fdrive/db/testing";
import { describe, expect, it } from "vitest";
import { createSetupClaimStore } from "./claim.js";

const ALICE = { accountId: "account-alice", baseUrl: "http://sftpgo-a:8080" };
const BOB = { accountId: "account-bob", baseUrl: "http://sftpgo-b:8080" };

describe("createSetupClaimStore", () => {
  it("allows only one racing claimant and lets that claimant resume", async () => {
    const settings = createMemoryRepos().settings;
    const first = createSetupClaimStore(settings);
    const second = createSetupClaimStore(settings);

    const result = await Promise.all([first.claim(ALICE), second.claim(BOB)]);

    expect(result.filter((value) => value === "claimed")).toHaveLength(1);
    expect(result.filter((value) => value === "taken")).toHaveLength(1);
    expect(await first.claim(ALICE)).toBe("resumed");
  });

  it("finalizes only the pending claimant", async () => {
    const store = createSetupClaimStore(createMemoryRepos().settings);
    await store.claim(ALICE);

    expect(await store.finalize(BOB)).toBe(false);
    expect(await store.finalize(ALICE)).toBe(true);
    expect(await store.current()).toEqual({ version: 1, state: "complete", ...ALICE });
  });

  it("resumes a pending claim after a process restart instead of leaving setup locked", async () => {
    const settings = createMemoryRepos().settings;
    const beforeRestart = createSetupClaimStore(settings);
    await beforeRestart.claim(ALICE);

    const afterRestart = createSetupClaimStore(settings);
    expect(await afterRestart.claim(ALICE)).toBe("resumed");
    expect(await afterRestart.finalize(ALICE)).toBe(true);
  });
});
