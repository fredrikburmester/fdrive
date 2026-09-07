import { expect, it } from "vitest";
import type { OfficeConfig } from "./types.ts";
import { callbackProofUrl, editorHostUrl, officeActionUrl } from "./urls.ts";

const config: OfficeConfig = {
  product: "onlyoffice",
  serverUrl: "http://internal/prefix",
  publicUrl: "https://app/onlyoffice",
  wopiUrl: "http://api/prefix/wopi",
  appUrl: "https://app/",
  maxBytes: 5,
};
it("rewrites trusted origin prefixes without changing query bytes", () => {
  expect(
    officeActionUrl("http://internal/prefix/editor?x=a%20b+%2f&<ui=UI&>", config, "file", "sv-SE"),
  ).toBe(
    "https://app/onlyoffice/editor?x=a%20b+%2f&ui=sv-SE&WOPISrc=http%3A%2F%2Fapi%2Fprefix%2Fwopi%2Ffiles%2Ffile",
  );
  expect(officeActionUrl("http://internal/prefix?x=1", config, "file")).toContain(
    "https://app/onlyoffice/?x=1&",
  );
  expect(officeActionUrl("https://app/onlyoffice/editor?", config, "file")).toContain(
    "https://app/onlyoffice/editor?",
  );
});
it("rejects alien origins and mismatched internal prefixes", () => {
  expect(() => officeActionUrl("http://internal/alien", config, "file")).toThrow();
  expect(() => officeActionUrl("https://evil/editor", config, "file")).toThrow();
});
it("uses configured callback origin with raw query and encodes host paths", () => {
  expect(callbackProofUrl("https://evil/wopi/files/file?x=a%2fb", config)).toBe(
    "http://api/prefix/wopi/files/file?x=a%2fb",
  );
  expect(() => callbackProofUrl("https://evil/other", config)).toThrow();
  expect(editorHostUrl(config, "identity", "/å a.docx", "view")).toBe(
    "https://app/office/identity/%C3%A5%20a.docx?mode=view",
  );
});
it("handles explicit default ports without corrupting the action path", () => {
  expect(officeActionUrl("http://internal:80/prefix/editor?x=1", config, "file")).toContain(
    "https://app/onlyoffice/editor?x=1&",
  );
  expect(officeActionUrl("http://internal/prefix/editor", config, "file")).toContain(
    "https://app/onlyoffice/editor?WOPISrc=",
  );
});

it("ignores a wopi hostname and requires the callback route prefix", () => {
  expect(callbackProofUrl("http://wopi/wopi/files/id/contents?x=a%2fb+z", config)).toBe(
    "http://api/prefix/wopi/files/id/contents?x=a%2fb+z",
  );
  expect(() => callbackProofUrl("http://api/other/wopi/files/id", config)).toThrow();
  expect(() => callbackProofUrl("http://api/wopi/files/id/extra", config)).toThrow();
});
