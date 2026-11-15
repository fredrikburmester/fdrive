import { expect, it, vi } from "vitest";
import { officeHarness } from "../../test/fixtures/office/harness.ts";
import { browserActor } from "./auth.ts";
import { officeLocation } from "./service.ts";
import type { OpenedFile } from "./types.ts";
import { currentWriteFile } from "./write-file.ts";

async function fixture() {
  const h = await officeHarness();
  const actor = await browserActor(h.deps, {
    principal: h.bob.principal,
    sessionId: h.bob.sessionId,
  });
  const file = await h.files.ensure(await officeLocation(h.deps, actor, "/a.docx"));
  const opened: OpenedFile = {
    actor,
    file,
    path: "/a.docx",
    stat: await h.storage.statFile("/a.docx"),
    mode: "edit",
    editAllowed: true,
  };
  return { h, opened };
}
it("keys a document by its owner, whoever opens it", async () => {
  const { h, opened } = await fixture();
  expect(opened.file).toMatchObject({ identityId: h.alice.identity.id, path: "/a.docx" });
});
it("resolves the current row for the login and checks its admission without loading credentials", async () => {
  const { h, opened } = await fixture();
  const fresh = { ...opened.file, path: "/moved.docx" };
  const files = { ...h.files, get: vi.fn(async () => fresh) };
  const outer = vi.spyOn(h.files, "get");
  const credentials = vi.spyOn(h.deps, "storageFactory");
  const pathFor = vi.spyOn(h.deps.grants, "pathFor");
  const admission = vi.fn(async () => true);
  expect(await currentWriteFile({ ...h.deps, canEdit: admission }, files, opened)).toMatchObject({
    file: fresh,
    path: "/moved.docx",
    actor: opened.actor,
  });
  expect(files.get).toHaveBeenCalledWith(opened.file.id);
  expect(pathFor).toHaveBeenCalledWith(h.bob.identity.id, fresh);
  expect(admission).toHaveBeenCalledWith(opened.actor, "/moved.docx");
  expect(outer).not.toHaveBeenCalled();
  expect(credentials).not.toHaveBeenCalled();
});
it.each(["missing", "id", "unreachable"])("rejects a %s row", async (kind) => {
  const { h, opened } = await fixture();
  const fresh =
    kind === "missing"
      ? null
      : {
          ...opened.file,
          ...(kind === "id" ? { id: "different-id" } : {}),
          // Another owner's file this login cannot reach.
          ...(kind === "unreachable" ? { identityId: h.bob.identity.id } : {}),
        };
  await expect(
    currentWriteFile(h.deps, { ...h.files, get: async () => fresh }, opened),
  ).rejects.toMatchObject({ status: 404 });
});
it("denies a newly moved source whose current path is outside the grant", async () => {
  const { h, opened } = await fixture();
  const files = {
    ...h.files,
    get: async () => ({ ...opened.file, path: "/restricted.docx" }),
  };
  await expect(
    currentWriteFile({ ...h.deps, canEdit: async (_, path) => path === "/a.docx" }, files, opened),
  ).rejects.toMatchObject({ status: 403 });
});
