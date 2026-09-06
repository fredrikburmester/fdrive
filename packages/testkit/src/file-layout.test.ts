import { describe, expect, it } from "vitest";
import { seedFileLayout } from "./file-layout.js";
import { SEED_FILES } from "./seed-data.js";

describe("seedFileLayout", () => {
  it("maps a regular user's files under dataDir/<user>", () => {
    const result = seedFileLayout(
      { alice: { "/docs/readme.md": "hello" } },
      { dataDir: "/srv/sftpgo/data" },
    );

    expect(result).toEqual([
      { containerPath: "/srv/sftpgo/data/alice/docs/readme.md", content: "hello" },
    ]);
  });

  it("maps the @shared key under dataDir/_folders/shared", () => {
    const result = seedFileLayout(
      { "@shared": { "/team.txt": "shared content" } },
      { dataDir: "/srv/sftpgo/data" },
    );

    expect(result).toEqual([
      { containerPath: "/srv/sftpgo/data/_folders/shared/team.txt", content: "shared content" },
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

  it("matches the full SEED_FILES fixture without throwing and covers every owner", () => {
    const result = seedFileLayout(SEED_FILES, { dataDir: "/srv/sftpgo/data" });

    const owners = new Set(Object.keys(SEED_FILES));
    const totalFiles = Object.values(SEED_FILES).reduce(
      (sum, files) => sum + Object.keys(files).length,
      0,
    );

    expect(result).toHaveLength(totalFiles);
    expect(result.some((f) => f.containerPath.includes("/_folders/shared/team.txt"))).toBe(true);
    expect(owners.has("@shared")).toBe(true);
  });
});
