import { createMemoryOfficeFileRepo } from "@fdrive/db";
import { expect, it } from "vitest";
import { createOfficeMoves } from "./moves.ts";

const ALICE = "00000000-0000-4000-8000-000000000001";
const BOB = "00000000-0000-4000-8000-000000000002";
const at = new Date("2026-11-15T00:00:00Z");

/** Bob finds alice's `/Team` as `/Shared with me/Team`; every other path is the login's own. */
async function fixture() {
  const files = createMemoryOfficeFileRepo();
  const moves = createOfficeMoves({
    files,
    clock: () => at,
    grants: {
      ownerPath: async (identityId, path) =>
        identityId === BOB && path.startsWith("/Shared with me/Team")
          ? { identityId: ALICE, path: path.replace("/Shared with me/Team", "/Team") }
          : { identityId, path },
    },
  });
  return { files, moves };
}

it("keeps a document's id across a rename, a folder move and a move by someone it is shared with", async () => {
  const { files, moves } = await fixture();
  const doc = await files.ensure({ identityId: ALICE, path: "/Team/plan.docx" });
  await moves.onMoved(ALICE, "/Team/plan.docx", "/Team/Plan 2026.docx", false);
  expect(await files.get(doc.id)).toMatchObject({ path: "/Team/Plan 2026.docx" });
  await moves.onMoved(ALICE, "/Team", "/Projects/Team", true);
  expect(await files.get(doc.id)).toMatchObject({ path: "/Projects/Team/Plan 2026.docx" });
  await moves.onMoved(ALICE, "/Projects/Team", "/Team", true);
  await moves.onMoved(
    BOB,
    "/Shared with me/Team/Plan 2026.docx",
    "/Shared with me/Team/a.docx",
    false,
  );
  expect(await files.get(doc.id)).toMatchObject({ identityId: ALICE, path: "/Team/a.docx" });
});

it("takes a document along into another owner's files", async () => {
  const { files, moves } = await fixture();
  const doc = await files.ensure({ identityId: BOB, path: "/draft.docx" });
  await moves.onMoved(BOB, "/draft.docx", "/Shared with me/Team/draft.docx", false);
  expect(await files.get(doc.id)).toMatchObject({ identityId: ALICE, path: "/Team/draft.docx" });
});

it("follows a document into the Trash and back, and drops it once deleted", async () => {
  const { files, moves } = await fixture();
  const doc = await files.ensure({ identityId: ALICE, path: "/Team/plan.docx" });
  await moves.onMoved(ALICE, "/Team/plan.docx", "/.trash/plan.docx", false);
  expect(await files.get(doc.id)).toMatchObject({ path: "/.trash/plan.docx" });
  // A new document where it was gets an id of its own.
  expect((await files.ensure({ identityId: ALICE, path: "/Team/plan.docx" })).id).not.toBe(doc.id);
  await moves.onMoved(ALICE, "/.trash/plan.docx", "/Team/restored.docx", false);
  expect(await files.get(doc.id)).toMatchObject({ path: "/Team/restored.docx" });
  await moves.onDeleted(BOB, "/Shared with me/Team/restored.docx", false);
  expect(await files.get(doc.id)).toBeNull();
});

it("never moves or deletes an owner's root", async () => {
  const { files, moves } = await fixture();
  const doc = await files.ensure({ identityId: BOB, path: "/x.docx" });
  await moves.onMoved(BOB, "/", "/elsewhere", true);
  await moves.onMoved(BOB, "/x.docx", "/", false);
  await moves.onDeleted(BOB, "/", true);
  expect(await files.get(doc.id)).toMatchObject({ path: "/x.docx" });
});
