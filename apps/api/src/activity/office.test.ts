import { randomUUID } from "node:crypto";
import { createMemoryStorage } from "@fdrive/core/testing";
import { expect, it, vi } from "vitest";
import type { OfficeActor, OfficeDeps } from "../office/types.js";
import { officeActivityPrincipal, recordOfficeAction } from "./office.js";
import type { PersonalActivityService } from "./service.js";

it("attributes Office saves to the authorized session, maps paths before recording and retains Save As lineage", async () => {
  const accountId = randomUUID(),
    identityId = randomUUID();
  const storage = createMemoryStorage();
  await storage.upload("/a", new Uint8Array([1]));
  const actor = {
    session: { accountId, idHash: "private-session-hash" },
    identity: { id: identityId, accountId },
    storage,
  } as unknown as OfficeActor;
  const identities = { get: vi.fn(async () => ({ accountId }) as { accountId: string } | null) },
    sessions = { getByIdHash: vi.fn(async () => ({ accountId }) as { accountId: string } | null) };
  const run = vi.fn<PersonalActivityService["run"]>(async (_principal, _input, work, facts) => {
    const value = await work();
    if (facts) expect(await facts(value)).toMatchObject({ path: "/b", kind: "file" });
    return { value, eventId: randomUUID(), historyPending: false };
  });
  const deps = {
    repos: { identities, sessions },
    clock: () => new Date(),
    activity: { run },
  } as unknown as OfficeDeps;
  const principal = officeActivityPrincipal(deps, actor);
  expect(await principal.verifyAuthority?.()).toBe(true);
  identities.get.mockResolvedValueOnce(null);
  expect(await principal.verifyAuthority?.()).toBe(false);
  sessions.getByIdHash.mockResolvedValueOnce(null);
  expect(await principal.verifyAuthority?.()).toBe(false);
  expect(
    await recordOfficeAction(
      deps,
      actor,
      "file.copy",
      "/a",
      "/b",
      "office-file-id",
      async () => 7,
      { size: 1 },
    ),
  ).toBe(7);
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({ accountId, identityId }),
    expect.objectContaining({
      source: "office",
      requested: { path: "/a", targetPath: "/b", variant: "save_as" },
      before: expect.objectContaining({ path: "/a" }),
      bridge: { namespace: "office", externalId: "office-file-id" },
    }),
    expect.any(Function),
    expect.any(Function),
  );
  await recordOfficeAction(deps, actor, "file.create", "/missing", "/b", undefined, async () => 1);
  expect(run.mock.calls.at(-1)?.[1]).not.toHaveProperty("before");
  expect(
    await recordOfficeAction(
      { ...deps, activity: undefined } as unknown as OfficeDeps,
      actor,
      "file.save",
      "/a",
      "/b",
      undefined,
      async () => 5,
    ),
  ).toBe(5);
});
