import { randomUUID } from "node:crypto";
import { createMemoryStorage } from "@fdrive/core/testing";
import { expect, it, vi } from "vitest";
import { testFileOperations } from "../../test/file-operations.js";
import type { OfficeActor, OfficeDeps } from "../office/types.js";
import { officeActivityPrincipal, officeFileActor } from "./office.js";
import type { PersonalActivityService } from "./service.js";

it("attributes Office saves to the authorized session and records Save As as a copy of the document", async () => {
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
  const run = vi.fn<PersonalActivityService["run"]>(async (_principal, _input, work) => {
    const value = await work();
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
  const files = testFileOperations({
    activity: { run } as unknown as PersonalActivityService,
  });
  await files.upload(officeFileActor(deps, actor, "office-file-id"), "/b", new Uint8Array([7]), {
    action: "file.copy",
    from: "/a",
  });
  expect(await new Response((await storage.download("/b")).body).arrayBuffer()).toEqual(
    new Uint8Array([7]).buffer,
  );
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({ accountId, identityId }),
    expect.objectContaining({
      action: "file.copy",
      source: "office",
      requested: { path: "/a", targetPath: "/b", variant: "save_as" },
      before: expect.objectContaining({ path: "/a" }),
      bridge: { namespace: "office", externalId: "office-file-id" },
    }),
    expect.any(Function),
    expect.any(Function),
  );
  // The target's facts are read once the bytes are there.
  expect(await run.mock.calls.at(-1)?.[3]?.(undefined)).toMatchObject({
    path: "/b",
    kind: "file",
    size: 1,
  });
  // A save records the document itself, with what was there before.
  await files.upload(officeFileActor(deps, actor, "office-file-id"), "/a", new Uint8Array([2]), {
    action: "file.save",
    overwrite: true,
  });
  expect(run.mock.calls.at(-1)?.[1]).toMatchObject({
    action: "file.save",
    requested: { path: "/a", kind: "file" },
    before: { path: "/a", kind: "file" },
  });
});
