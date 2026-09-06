import { describe, expect, it } from "vitest";
import { fileUrl, folderUrl } from "./urls.js";

describe("fileUrl", () => {
  it("prefixes the public url and /view", () => {
    expect(fileUrl("https://fdrive.example.com", "/docs/report.pdf")).toBe(
      "https://fdrive.example.com/view/docs/report.pdf",
    );
  });

  it("falls back to a relative path when no public url is configured", () => {
    expect(fileUrl(undefined, "/docs/report.pdf")).toBe("/view/docs/report.pdf");
  });
});

describe("folderUrl", () => {
  it("prefixes the public url and /files", () => {
    expect(folderUrl("https://fdrive.example.com", "/docs")).toBe(
      "https://fdrive.example.com/files/docs",
    );
  });

  it("falls back to a relative path when no public url is configured", () => {
    expect(folderUrl(undefined, "/docs")).toBe("/files/docs");
  });
});
