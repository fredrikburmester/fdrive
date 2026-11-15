import type { OfficeSettings } from "@fdrive/contracts";
import { expect, it, vi } from "vitest";
import { createOfficeEditPolicy } from "./edit-policy.ts";
import type { OfficeActor } from "./types.ts";

function actor(username: string): OfficeActor {
  return { identity: { externalUsername: username } } as OfficeActor;
}

function policy(settings: Partial<OfficeSettings> = {}, readOnly = async () => false) {
  return createOfficeEditPolicy({
    settings: async () => ({
      revision: 1,
      enabled: true,
      editingEnabled: true,
      editorUsernames: ["alice"],
      ...settings,
    }),
    grants: { isReadOnly: vi.fn(readOnly) },
  });
}

it("lets only the chosen editors edit", async () => {
  const canEdit = policy();
  expect(await canEdit(actor("alice"), "/a.docx")).toBe(true);
  expect(await canEdit(actor("bob"), "/a.docx")).toBe(false);
  expect(await canEdit(actor("Alice"), "/a.docx")).toBe(false);
});

it("lets nobody edit while Office or editing is off", async () => {
  expect(await policy({ enabled: false })(actor("alice"), "/a.docx")).toBe(false);
  expect(await policy({ editingEnabled: false })(actor("alice"), "/a.docx")).toBe(false);
});

it("keeps a folder shared to view only read-only for an editor", async () => {
  const readOnly = vi.fn(async (_identity: unknown, path: string) =>
    path.startsWith("/Shared with me/Team/"),
  );
  const canEdit = createOfficeEditPolicy({
    settings: async () => ({
      revision: 1,
      enabled: true,
      editingEnabled: true,
      editorUsernames: ["alice"],
    }),
    grants: { isReadOnly: readOnly },
  });
  expect(await canEdit(actor("alice"), "/Shared with me/Team/a.docx")).toBe(false);
  expect(await canEdit(actor("alice"), "/Shared with me/Other/a.docx")).toBe(true);
  expect(readOnly).toHaveBeenCalledWith(
    { externalUsername: "alice" },
    "/Shared with me/Team/a.docx",
  );
});

it("refuses a noncanonical path before reading settings", async () => {
  const settings = vi.fn();
  const canEdit = createOfficeEditPolicy({ settings, grants: { isReadOnly: vi.fn() } });
  expect(await canEdit(actor("alice"), "/a/../b.docx")).toBe(false);
  expect(settings).not.toHaveBeenCalled();
});
