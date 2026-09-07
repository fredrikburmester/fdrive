import { expect, it } from "vitest";
import { allowsOfficeEdit, type OfficeEditRule, parseOfficeEditRules } from "./edit-policy.ts";

const providerId = "12345678-1234-4234-8234-123456789abc";
const identity = { providerId, externalUsername: "alice" };
const rule: OfficeEditRule = {
  providerId,
  username: "alice",
  path: "/",
  recursive: true,
  allow: true,
};

it("defaults to deny and parses only bounded strict operator rules", () => {
  expect(parseOfficeEditRules(undefined)).toEqual([]);
  expect(parseOfficeEditRules("[]")).toEqual([]);
  expect(parseOfficeEditRules(JSON.stringify([rule]))).toEqual([rule]);
  for (const value of [
    "",
    "broken",
    "{}",
    JSON.stringify(Array.from({ length: 501 }, () => rule)),
    " ".repeat(131073),
  ])
    expect(() => parseOfficeEditRules(value)).toThrow();
  expect(() => parseOfficeEditRules(`"${"Å".repeat(65536)}"`)).toThrow("128 KiB");
  for (const changed of [
    { providerId: providerId.toUpperCase() },
    { providerId: "*" },
    { username: "" },
    { username: "a".repeat(256) },
    { username: "*" },
    { username: "al?ce" },
    { path: "/a//b" },
    { path: "/a/../b" },
    { path: "/x/" },
    { path: "/a*" },
    { path: "/a?" },
    { recursive: "true" },
    { allow: 1 },
    { secret: "not allowed" },
  ])
    expect(() => parseOfficeEditRules(JSON.stringify([{ ...rule, ...changed }]))).toThrow();
});
it("requires exact immutable provider and username plus a canonical path", () => {
  expect(allowsOfficeEdit([], identity, "/a.docx")).toBe(false);
  expect(allowsOfficeEdit([rule], identity, "/a.docx")).toBe(true);
  expect(allowsOfficeEdit([rule], { ...identity, providerId: "other" }, "/a.docx")).toBe(false);
  expect(allowsOfficeEdit([rule], { ...identity, externalUsername: "Alice" }, "/a.docx")).toBe(
    false,
  );
  expect(allowsOfficeEdit([rule], identity, "/a/../b")).toBe(false);
});
it("honors segment boundaries, exact rules, nested exceptions and deny ties in either order", () => {
  const folder = { ...rule, path: "/documents" };
  expect(allowsOfficeEdit([folder], identity, "/documents")).toBe(true);
  expect(allowsOfficeEdit([folder], identity, "/documents/a.docx")).toBe(true);
  expect(allowsOfficeEdit([folder], identity, "/documents-other/a.docx")).toBe(false);
  expect(allowsOfficeEdit([{ ...folder, recursive: false }], identity, "/documents/a.docx")).toBe(
    false,
  );
  const denied = { ...folder, path: "/documents/private", allow: false };
  const exception = { ...folder, path: "/documents/private/public.docx", recursive: false };
  expect(allowsOfficeEdit([folder, denied], identity, "/documents/private/a.docx")).toBe(false);
  expect(
    allowsOfficeEdit([exception, denied, folder], identity, "/documents/private/public.docx"),
  ).toBe(true);
  for (const rules of [
    [rule, { ...rule, allow: false }],
    [{ ...rule, allow: false }, rule],
  ])
    expect(allowsOfficeEdit(rules, identity, "/a.docx")).toBe(false);
  expect(allowsOfficeEdit([{ ...rule, recursive: false }], identity, "/")).toBe(true);
  expect(allowsOfficeEdit([{ ...rule, recursive: false }], identity, "/a.docx")).toBe(false);
});
