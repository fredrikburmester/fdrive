import type { OfficeOpenResponse } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import { parseOfficeMessage, validOfficeDescriptor } from "./messages";

const source = {};
const origin = "https://editor.test";
const descriptor: OfficeOpenResponse = {
  identityId: "identity",
  fileId: "file",
  path: "/a.docx",
  mode: "view",
  actionUrl: `${origin}/editor?WOPISrc=host`,
  editorOrigin: origin,
  formFields: { access_token: "unit-test-token", access_token_ttl: "100" },
  expiresAt: "2026-09-07T00:00:00.000Z",
};
const parse = (data: unknown) => parseOfficeMessage({ origin, source, data }, origin, source);

describe("editor messages", () => {
  it("requires both origin and exact iframe source", () => {
    const event = { origin, source, data: { MessageId: "UI_Close" } };
    expect(parseOfficeMessage(event, origin, source)).toEqual({ MessageId: "UI_Close" });
    expect(parseOfficeMessage(event, "https://evil.test", source)).toBeNull();
    expect(parseOfficeMessage(event, origin, {})).toBeNull();
    expect(parseOfficeMessage(event, origin, null)).toBeNull();
    expect(parseOfficeMessage(event, origin, undefined)).toBeNull();
  });
  it("accepts recognized messages only, from objects or JSON", () => {
    for (const message of [
      { MessageId: "UI_Edit" },
      { MessageId: "App_LoadingStatus" },
      { MessageId: "App_LoadingStatus", Values: {} },
      { MessageId: "App_LoadingStatus", Values: { Status: "Document_Loaded" } },
      { MessageId: "File_Rename", Values: { NewName: "renamed.docx" } },
      { MessageId: "UI_Hyperlink", Values: { Url: "/office/identity/a.docx" } },
    ]) {
      expect(parse(message)).toEqual(message);
      expect(parse(JSON.stringify(message))).toEqual(message);
    }
    for (const data of [
      "bad json",
      null,
      [],
      1,
      {},
      { MessageId: "unknown", Values: {} },
      { MessageId: "App_LoadingStatus", Values: null },
      { MessageId: "App_LoadingStatus", Values: { Status: false } },
      { MessageId: "File_Rename", Values: { NewName: 1 } },
      { MessageId: "File_Rename", Values: { NewName: "x".repeat(256) } },
      { MessageId: "UI_Hyperlink", Values: { Url: 1 } },
      { MessageId: "UI_Hyperlink", Values: { Url: "x".repeat(8193) } },
    ])
      expect(parse(data)).toBeNull();
  });
});
it("verifies response identity/path and safe editor POST destination", () => {
  expect(validOfficeDescriptor(descriptor, "identity", "/a.docx")).toBe(true);
  expect(validOfficeDescriptor(descriptor, "other", "/a.docx")).toBe(false);
  expect(validOfficeDescriptor(descriptor, "identity", "/other.docx")).toBe(false);
  for (const actionUrl of [
    "bad",
    "javascript:alert(1)",
    "https://other.test/a",
    `${origin}/a#hash`,
    `${origin}/a?access_token=bad`,
    "https://user:pass@editor.test/a",
  ])
    expect(validOfficeDescriptor({ ...descriptor, actionUrl }, "identity", "/a.docx")).toBe(false);
  expect(validOfficeDescriptor({ ...descriptor, formFields: {} }, "identity", "/a.docx")).toBe(
    false,
  );
  expect(
    validOfficeDescriptor(
      { ...descriptor, formFields: { access_token: "" } },
      "identity",
      "/a.docx",
    ),
  ).toBe(false);
});
