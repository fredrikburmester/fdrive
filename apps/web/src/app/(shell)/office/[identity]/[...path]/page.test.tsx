import { expect, it } from "vitest";
import OfficeRoute, { dynamic } from "./page";

it("renders a dynamic identity-scoped office route with an explicit safe default mode", async () => {
  expect(dynamic).toBe("force-dynamic");
  const page = await OfficeRoute({
    params: Promise.resolve({ identity: "id", path: ["folder", "a%20b.docx"] }),
    searchParams: Promise.resolve({}),
  });
  expect(page).toMatchObject({
    props: { identityId: "id", path: "/folder/a b.docx", mode: "view" },
  });
});

it("decodes a literal percent filename only once", async () => {
  const page = await OfficeRoute({
    params: Promise.resolve({ identity: "id", path: ["a%2520b.docx"] }),
    searchParams: Promise.resolve({ mode: "edit" }),
  });
  expect(page).toMatchObject({ props: { path: "/a%20b.docx", mode: "edit" } });
});
