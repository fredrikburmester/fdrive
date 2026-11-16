import { createHash } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { migrationsThrough, SQUASHED_MIGRATIONS } from "./squashed-migrations.js";

async function journalTags(folder: string): Promise<string[]> {
  const journal = JSON.parse(await readFile(path.join(folder, "meta/_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  return journal.entries.map((entry) => entry.tag);
}

describe("squashed migrations", () => {
  it("keeps all 48 of them, each with its SQL", async () => {
    const tags = await journalTags(SQUASHED_MIGRATIONS);
    expect(tags).toHaveLength(48);
    expect(tags[0]).toBe("0000_init");
    expect(tags.at(-1)).toBe("0047_drop_desktop_original_path");
    const files = (await readdir(SQUASHED_MIGRATIONS)).filter((name) => name.endsWith(".sql"));
    expect(files.sort()).toEqual(tags.map((tag) => `${tag}.sql`).sort());
  });

  it("keeps the bytes rc.11 ran, which its databases record by hash", async () => {
    // 0046_trash_items, as drizzle recorded it in every database rc.11 migrated.
    const bytes = await readFile(path.join(SQUASHED_MIGRATIONS, "0046_trash_items.sql"));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "90eb50dd1fac64435339ee01bc01f505d833b52342acc83a31febf3906b1515e",
    );
  });
});

describe("migrationsThrough", () => {
  it("copies migrations into a folder whose journal stops at the one asked for", async () => {
    const folder = await migrationsThrough(SQUASHED_MIGRATIONS, "0045_drop_providers");
    try {
      const tags = await journalTags(folder);
      expect(tags).toHaveLength(46);
      expect(tags.at(-1)).toBe("0045_drop_providers");
      expect(await readFile(path.join(folder, "0045_drop_providers.sql"), "utf8")).toBe(
        await readFile(path.join(SQUASHED_MIGRATIONS, "0045_drop_providers.sql"), "utf8"),
      );
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it("refuses a migration the folder does not have", async () => {
    await expect(migrationsThrough(SQUASHED_MIGRATIONS, "0048_nothing")).rejects.toThrow(
      "No migration 0048_nothing",
    );
  });
});
