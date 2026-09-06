import { describe, expect, it } from "vitest";
import { parseSelectParam, revealTarget } from "./reveal";

describe("revealTarget", () => {
  it("appends a select query parameter to a bare href", () => {
    expect(revealTarget("/files/docs", "readme.md")).toBe("/files/docs?select=readme.md");
  });

  it("url-encodes a name with special characters", () => {
    expect(revealTarget("/files/docs", "a b & c.txt")).toBe(
      "/files/docs?select=a%20b%20%26%20c.txt",
    );
  });

  it("uses '&' when the href already has a query string", () => {
    expect(revealTarget("/files/docs?sort=name", "readme.md")).toBe(
      "/files/docs?sort=name&select=readme.md",
    );
  });
});

describe("parseSelectParam", () => {
  it("reads a select param from a leading-'?' search string", () => {
    expect(parseSelectParam("?select=readme.md")).toBe("readme.md");
  });

  it("reads a select param from a bare search string", () => {
    expect(parseSelectParam("select=readme.md")).toBe("readme.md");
  });

  it("decodes a url-encoded name", () => {
    expect(parseSelectParam("?select=a%20b%20%26%20c.txt")).toBe("a b & c.txt");
  });

  it("returns null when there is no select param", () => {
    expect(parseSelectParam("?sort=name")).toBeNull();
  });

  it("returns null for an empty search string", () => {
    expect(parseSelectParam("")).toBeNull();
  });

  it("returns null for an empty select value", () => {
    expect(parseSelectParam("?select=")).toBeNull();
  });
});
