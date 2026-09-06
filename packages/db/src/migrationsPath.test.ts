import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveMigrationsFolder } from "./migrationsPath.js";

describe("resolveMigrationsFolder", () => {
  it("resolves the drizzle folder one level above a source module", () => {
    const result = resolveMigrationsFolder("file:///repo/packages/db/src/index.ts");

    expect(result).toBe(path.join("/repo/packages/db", "drizzle"));
  });

  it("resolves the same drizzle folder from a built dist module", () => {
    const result = resolveMigrationsFolder("file:///repo/packages/db/dist/index.js");

    expect(result).toBe(path.join("/repo/packages/db", "drizzle"));
  });

  it("resolves correctly from a nested bin module", () => {
    const result = resolveMigrationsFolder("file:///repo/packages/db/src/bin/migrate.ts");

    expect(result).toBe(path.join("/repo/packages/db/src", "drizzle"));
  });
});
