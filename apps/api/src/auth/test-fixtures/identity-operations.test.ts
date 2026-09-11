import { createMemoryRepos } from "@fdrive/db/testing";
import { describe, expect, it } from "vitest";
import { memoryIdentityOperations } from "./index.ts";

const START = new Date("2026-09-11T10:00:00Z");
const LATER = new Date("2026-09-11T10:10:00Z");
const sealCredential = () => ({ ciphertext: new Uint8Array([1, 2]), keyId: "test" });

async function setup() {
  const repos = createMemoryRepos();
  const links = memoryIdentityOperations(repos);
  const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl: "http://storage.test" });
  const input = {
    providerId: provider.id,
    username: "alice",
    at: START,
    sealCredential,
    session: {
      idHash: "initial",
      expiresAt: new Date("2026-09-12T10:00:00Z"),
      userAgent: "fixture",
      ip: "127.0.0.1",
    },
  };
  const login = await links.loginVerified(input);
  return { repos, links, input, ...login };
}

describe("memory identity operations parity", () => {
  it("preserves login age through switch, rotate and unlink; rotation alone touches lastSeenAt", async () => {
    const { repos, links, input, identity, session } = await setup();
    expect(session.createdAt).toEqual(START);
    expect(session.lastSeenAt).toEqual(START);
    const linked = await links.linkVerified({
      ...input,
      username: "bob",
      accountId: identity.accountId,
    });
    await links.switchActive({
      accountId: identity.accountId,
      identityId: linked.id,
      sessionIdHash: session.idHash,
      at: LATER,
    });
    expect(await repos.sessions.getByIdHash(session.idHash, LATER)).toMatchObject({
      createdAt: START,
      lastSeenAt: START,
      activeIdentityId: linked.id,
    });
    const rotated = await links.rotateSession({
      accountId: identity.accountId,
      oldSessionIdHash: session.idHash,
      newSessionIdHash: "rotated",
      activeIdentityId: linked.id,
      at: LATER,
    });
    expect(rotated).toMatchObject({
      createdAt: START,
      lastSeenAt: LATER,
      expiresAt: session.expiresAt,
    });
    expect(await repos.sessions.getByIdHash(session.idHash, LATER)).toBeNull();
    const touchedAt = new Date("2026-09-11T10:20:00Z");
    await repos.sessions.touch(rotated.idHash, {
      lastSeenAt: touchedAt,
      expiresAt: session.expiresAt,
    });
    await links.unlink({
      accountId: identity.accountId,
      identityId: linked.id,
      requestingSessionIdHash: rotated.idHash,
      at: LATER,
    });
    expect(await repos.sessions.getByIdHash(rotated.idHash, LATER)).toMatchObject({
      createdAt: START,
      lastSeenAt: touchedAt,
      activeIdentityId: identity.id,
    });
  });

  it.each(["login", "link"])(
    "clears cached tokens on verified %s, while generic credential writes retain them",
    async (operation) => {
      const { repos, links, input, identity } = await setup();
      await repos.credentials.setCachedToken(identity.id, {
        sealed: "old-token",
        expiresAt: LATER,
      });
      await repos.credentials.put({ identityId: identity.id, ...sealCredential() });
      expect((await repos.credentials.get(identity.id))?.cachedToken).toBe("old-token");
      if (operation === "login") {
        await links.loginVerified({
          ...input,
          at: LATER,
          session: { ...input.session, idHash: "next" },
        });
      } else {
        await links.linkVerified({ ...input, at: LATER, accountId: identity.accountId });
      }
      expect(await repos.credentials.get(identity.id)).toMatchObject({
        cachedToken: null,
        cachedTokenExpiresAt: null,
      });
    },
  );

  it("remaps used tags on transfer and unlink, retaining target colors and other identities' metadata", async () => {
    const { repos, links, input, identity } = await setup();
    const target = await repos.accounts.create({ displayName: "Target" });
    await repos.identities.create({
      accountId: target.id,
      providerId: input.providerId,
      externalUsername: "other",
    });
    const sourceTags = await Promise.all([
      repos.tags.create(identity.accountId, { name: "Shared", color: "red" }),
      repos.tags.create(identity.accountId, { name: "Private", color: "green" }),
      repos.tags.create(identity.accountId, { name: "Unused", color: null }),
    ]);
    const shared = await repos.tags.create(target.id, { name: "Shared", color: "blue" });
    const sourceIds = sourceTags.slice(0, 2).map((tag) => tag.id);
    await repos.fileTags.setTags(identity.id, "/a.txt", sourceIds);
    await repos.favorites.add(identity.id, "/a.txt", "file");
    const sibling = await repos.identities.create({
      accountId: identity.accountId,
      providerId: input.providerId,
      externalUsername: "sibling",
    });
    await repos.fileTags.setTags(sibling.id, "/same.txt", sourceIds);

    await links.linkVerified({ ...input, accountId: target.id, at: LATER });
    const targetTags = await repos.tags.list(target.id);
    expect(targetTags.map((tag) => tag.name).sort()).toEqual(["Private", "Shared"]);
    expect(targetTags.find((tag) => tag.name === "Shared")).toEqual(shared);
    expect(await repos.fileTags.tagsForPaths(identity.id, ["/a.txt"])).toEqual(
      new Map([["/a.txt", expect.arrayContaining(targetTags.map((tag) => tag.id))]]),
    );
    expect(await repos.fileTags.tagsForPaths(sibling.id, ["/same.txt"])).toEqual(
      new Map([["/same.txt", sourceIds]]),
    );
    const unlinked = await links.unlink({
      accountId: target.id,
      identityId: identity.id,
      at: LATER,
    });
    const movedTags = await repos.tags.list(unlinked.identity.accountId);
    expect(movedTags.map((tag) => [tag.name, tag.color]).sort()).toEqual([
      ["Private", "green"],
      ["Shared", "blue"],
    ]);
    const assignments = (await repos.fileTags.tagsForPaths(identity.id, ["/a.txt"])).get("/a.txt");
    expect(assignments?.sort()).toEqual(movedTags.map((tag) => tag.id).sort());
    expect(await repos.tags.list(target.id)).toEqual(targetTags);
    expect(await repos.tags.list(identity.accountId)).toEqual(sourceTags);
    expect((await repos.favorites.list(identity.id)).map((row) => row.path)).toEqual(["/a.txt"]);
  });
});
