import { describe, expect, it } from "vitest";
import { seedFileLayout } from "./file-layout.js";
import { SEED_FILES } from "./seed-data.js";

describe("seedFileLayout", () => {
  it("maps a user's files under dataDir/<user>", () => {
    const result = seedFileLayout(
      { alice: { "/docs/readme.md": "hello" } },
      { dataDir: "/srv/files" },
    );

    expect(result).toEqual([
      { containerPath: "/srv/files/alice/docs/readme.md", content: "hello" },
    ]);
  });

  it("flattens multiple owners and multiple files per owner", () => {
    const result = seedFileLayout(
      {
        alice: { "/a.txt": "a", "/b.txt": "b" },
        bob: { "/c.txt": "c" },
      },
      { dataDir: "/data" },
    );

    expect(result).toHaveLength(3);
    expect(result).toEqual(
      expect.arrayContaining([
        { containerPath: "/data/alice/a.txt", content: "a" },
        { containerPath: "/data/alice/b.txt", content: "b" },
        { containerPath: "/data/bob/c.txt", content: "c" },
      ]),
    );
  });

  it("returns an empty array for an empty input", () => {
    expect(seedFileLayout({}, { dataDir: "/data" })).toEqual([]);
  });

  it("lays out every file of the full SEED_FILES fixture inside its owner's home", () => {
    const result = seedFileLayout(SEED_FILES, { dataDir: "/srv/files" });
    const totalFiles = Object.values(SEED_FILES).reduce(
      (sum, files) => sum + Object.keys(files).length,
      0,
    );

    expect(result).toHaveLength(totalFiles);
    for (const owner of Object.keys(SEED_FILES)) {
      expect(result.some((file) => file.containerPath.startsWith(`/srv/files/${owner}/`))).toBe(
        true,
      );
    }
  });
});
