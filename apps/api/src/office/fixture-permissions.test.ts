import { expect, it } from "vitest";
import { officeHarness } from "../../test/fixtures/office/harness.ts";
import { fixtureOfficeAuthorizer } from "../../test/fixtures/office/seeded-permissions.ts";
import { browserActor } from "./auth.ts";

it("binds the isolated fixture's known seeded grants to its exact provider", async () => {
  const h = await officeHarness();
  const canEdit = fixtureOfficeAuthorizer(h.provider.id);
  for (const user of [h.alice, h.bob, h.reader]) {
    const actor = await browserActor(h.deps, {
      principal: user.principal,
      sessionId: user.sessionId,
    });
    expect(await canEdit(actor, "/folder/file.docx")).toBe(user !== h.reader);
    expect(
      await canEdit(
        { ...actor, identity: { ...actor.identity, providerId: "other" } },
        "/file.docx",
      ),
    ).toBe(false);
    expect(await canEdit(actor, "/../file.docx")).toBe(false);
  }
});
