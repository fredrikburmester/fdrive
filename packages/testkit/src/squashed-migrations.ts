import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The migrations the baseline in `packages/db/drizzle` replaced, 0000 to 0047:
 * their SQL and journal byte for byte as v0.7.0-rc.11 (through 0046) and
 * main's edge build (0047) ran them. Tests build the databases those releases
 * left from them, to upgrade them. Nothing ships them.
 */
export const SQUASHED_MIGRATIONS = fileURLToPath(
  new URL("../fixtures/squashed-migrations", import.meta.url),
);

/**
 * Copies the drizzle migrations in `folder` up to and including `through`, a
 * tag such as `0046_trash_items`, into a new temporary folder for drizzle's
 * migrator and returns its path. The caller removes it.
 */
export async function migrationsThrough(folder: string, through: string): Promise<string> {
  const journal = JSON.parse(await readFile(path.join(folder, "meta/_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  const last = journal.entries.findIndex((entry) => entry.tag === through);
  if (last < 0) throw new Error(`No migration ${through} in ${folder}`);
  const copy = await mkdtemp(path.join(tmpdir(), "fdrive-migrations-"));
  await cp(folder, copy, { recursive: true });
  await writeFile(
    path.join(copy, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, last + 1) }),
  );
  return copy;
}
