import { describe, expect, it } from "vitest";
import { languageKeyFor, loadLanguageExtension } from "./language";

describe("languageKeyFor", () => {
  it.each([
    [".md", "markdown"],
    [".markdown", "markdown"],
    [".mdx", "markdown"],
    [".js", "javascript"],
    [".jsx", "javascript"],
    [".mjs", "javascript"],
    [".cjs", "javascript"],
    [".ts", "javascript"],
    [".tsx", "javascript"],
    [".json", "json"],
    [".css", "css"],
    [".scss", "css"],
    [".html", "html"],
    [".htm", "html"],
    [".py", "python"],
    [".yml", "yaml"],
    [".yaml", "yaml"],
  ] as const)("maps %s to %s", (ext, expected) => {
    expect(languageKeyFor(ext)).toBe(expected);
  });

  it("is case-insensitive", () => {
    expect(languageKeyFor(".MD")).toBe("markdown");
  });

  it("falls back to none for an unknown extension", () => {
    expect(languageKeyFor(".xyz")).toBe("none");
  });

  it("falls back to none for an empty extension", () => {
    expect(languageKeyFor("")).toBe("none");
  });
});

describe("loadLanguageExtension", () => {
  it("returns an empty array for none", async () => {
    expect(await loadLanguageExtension("none")).toEqual([]);
  });

  it.each(["markdown", "javascript", "json", "css", "html", "python", "yaml"] as const)(
    "resolves a non-empty extension list for %s",
    async (key) => {
      const extensions = await loadLanguageExtension(key);
      expect(extensions.length).toBeGreaterThan(0);
    },
  );
});
