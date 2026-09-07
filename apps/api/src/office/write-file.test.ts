import { expect, it, vi } from "vitest";
import { officeHarness } from "../../test/fixtures/office/harness.ts";
import { browserActor } from "./auth.ts";
import { officeLocation } from "./service.ts";
import type { OpenedFile } from "./types.ts";
import { currentWriteFile } from "./write-file.ts";

async function fixture() {
  const h = await officeHarness();
  const actor = await browserActor(h.deps, {
    principal: h.alice.principal,
    sessionId: h.alice.sessionId,
  });
  const file = await h.files.ensure(officeLocation(actor, "/a.docx"));
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
it("resolves the current scoped row and checks its admission without loading credentials", async () => {
  const { h, opened } = await fixture();
  const fresh = { ...opened.file, path: "shared/moved.docx" };
  const files = { ...h.files, get: vi.fn(async () => fresh) };
  const outer = vi.spyOn(h.files, "get");
  const credentials = vi.spyOn(h.deps, "storageFactory");
  const admission = vi.fn(async () => true);
  expect(await currentWriteFile({ ...h.deps, canEdit: admission }, files, opened)).toMatchObject({
    file: fresh,
    path: "/moved.docx",
    actor: opened.actor,
  });
  expect(files.get).toHaveBeenCalledWith(opened.file.id);
  expect(admission).toHaveBeenCalledWith(opened.actor, "/moved.docx");
  expect(outer).not.toHaveBeenCalled();
  expect(credentials).not.toHaveBeenCalled();
});
it.each(["missing", "id", "provider", "root", "outside"])(
  "rejects a %s scoped row",
  async (kind) => {
    const { h, opened } = await fixture();
    const fresh =
      kind === "missing"
        ? null
        : {
            ...opened.file,
            ...(kind === "id" ? { id: "different-id" } : {}),
            ...(kind === "provider" ? { providerId: "different-provider" } : {}),
            ...(kind === "root" ? { rootName: "different-root" } : {}),
            ...(kind === "outside" ? { path: "other/a.docx" } : {}),
          };
    await expect(
      currentWriteFile(h.deps, { ...h.files, get: async () => fresh }, opened),
    ).rejects.toMatchObject({ status: 404 });
  },
);
it("accepts a noncanonically stored path that still round trips to the same file", async () => {
  const { h, opened } = await fixture();
  const fresh = { ...opened.file, path: "shared//a.docx" };
  const result = await currentWriteFile(h.deps, { ...h.files, get: async () => fresh }, opened);
  expect(result.path).toBe("/a.docx");
});
it("denies a newly moved source whose current path is outside the grant", async () => {
  const { h, opened } = await fixture();
  const files = {
    ...h.files,
    get: async () => ({ ...opened.file, path: "shared/restricted.docx" }),
  };
  await expect(
    currentWriteFile({ ...h.deps, canEdit: async (_, path) => path === "/a.docx" }, files, opened),
  ).rejects.toMatchObject({ status: 403 });
});
