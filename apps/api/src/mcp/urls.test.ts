import { describe, expect, it } from "vitest";
import { fileUrl, folderUrl } from "./urls.js";

describe("fileUrl", () => {
  it("encodes punctuation and literal percent characters as path segments", () => {
    expect(fileUrl("https://fdrive.example.com", "/docs/report#draft?%41.txt")).toBe(
      "https://fdrive.example.com/view/docs/report%23draft%3F%2541.txt",
    );
  });
  it("prefixes the public url and /view", () => {
    expect(fileUrl("https://fdrive.example.com", "/docs/report.pdf")).toBe(
      "https://fdrive.example.com/view/docs/report.pdf",
    );
  });

  it("falls back to a relative path when no public url is configured", () => {
    expect(fileUrl(null, "/docs/report.pdf")).toBe("/view/docs/report.pdf");
  });
});

describe("folderUrl", () => {
  it("prefixes the public url and /files", () => {
    expect(folderUrl("https://fdrive.example.com", "/docs")).toBe(
      "https://fdrive.example.com/files/docs",
    );
  });

  it("falls back to a relative path when no public url is configured", () => {
    expect(folderUrl(null, "/docs")).toBe("/files/docs");
  });
});
