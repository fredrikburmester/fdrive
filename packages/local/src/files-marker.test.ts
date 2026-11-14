import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isStorageError } from "@fdrive/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFilesFolderGuard,
  FILES_FOLDER_REASONS,
  FILES_MARKER,
  type FilesFolderFacts,
  verifyFilesFolder,
} from "./files-marker.js";

const ID = "6f1c7a52-3d3e-4b8e-9a51-0c2f4f3f9d10";
const OTHER = "0b8f4f0e-6a4c-4f6e-8d33-7f1e2a9c4b21";
const asRoot = process.getuid?.() === 0;

let base: string;
let root: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "fdrive-files-marker-"));
  root = join(base, "files");
  await mkdir(root);
});

afterEach(async () => {
  await chmod(root, 0o700).catch(() => undefined);
  await rm(base, { recursive: true, force: true });
});

function facts(holds: boolean | Error = false, id: string | Error = ID) {
  return {
    installationId: vi.fn(async () => {
      if (id instanceof Error) throw id;
      return id;
    }),
    holdsFiles: vi.fn(async () => {
      if (holds instanceof Error) throw holds;
      return holds;
    }),
  } satisfies FilesFolderFacts;
}

const marker = () => readFile(join(root, FILES_MARKER), "utf8");

describe("verifyFilesFolder", () => {
  it("adopts an empty folder on an installation with no users or indexed files", async () => {
    const known = facts(false);
    await expect(verifyFilesFolder(root, known)).resolves.toEqual({ ok: true, adopted: true });
    expect(await marker()).toBe(`${ID}\n`);
    expect(known.holdsFiles).toHaveBeenCalledOnce();
  });

  it("adopts a folder that already has files without asking the database about them", async () => {
    await mkdir(join(root, "alice"));
    const known = facts(true);
    await expect(verifyFilesFolder(root, known)).resolves.toEqual({ ok: true, adopted: true });
    expect(await marker()).toBe(`${ID}\n`);
    expect(known.holdsFiles).not.toHaveBeenCalled();
  });

  it("refuses an empty folder while the installation has users or indexed files", async () => {
    await expect(verifyFilesFolder(root, facts(true))).resolves.toEqual({
      ok: false,
      reason: FILES_FOLDER_REASONS.empty,
    });
    await expect(marker()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts a folder whose marker names this installation, empty or not", async () => {
    await writeFile(join(root, FILES_MARKER), `  ${ID}\n`);
    const known = facts(true);
    await expect(verifyFilesFolder(root, known)).resolves.toEqual({ ok: true, adopted: false });
    expect(known.holdsFiles).not.toHaveBeenCalled();
  });

  it("refuses a folder whose marker names another installation and leaves the marker", async () => {
    await mkdir(join(root, "alice"));
    await writeFile(join(root, FILES_MARKER), OTHER);
    await expect(verifyFilesFolder(root, facts(false))).resolves.toEqual({
      ok: false,
      reason: FILES_FOLDER_REASONS.foreign,
    });
    expect(await marker()).toBe(OTHER);
  });

  it("adopts an empty folder whose empty marker an administrator made", async () => {
    await writeFile(join(root, FILES_MARKER), "\n");
    await expect(verifyFilesFolder(root, facts(true))).resolves.toEqual({
      ok: true,
      adopted: true,
    });
    expect(await marker()).toBe(`${ID}\n`);
  });

  it("refuses a missing folder or a file in its place", async () => {
    const missing = { ok: false, reason: FILES_FOLDER_REASONS.missing };
    await expect(verifyFilesFolder(join(base, "absent"), facts())).resolves.toEqual(missing);
    await writeFile(join(base, "plain"), "x");
    await expect(verifyFilesFolder(join(base, "plain"), facts())).resolves.toEqual(missing);
  });

  it("refuses when the database cannot say what it holds", async () => {
    const database = { ok: false, reason: FILES_FOLDER_REASONS.database };
    await expect(verifyFilesFolder(root, facts(false, new Error("down")))).resolves.toEqual(
      database,
    );
    await expect(verifyFilesFolder(root, facts(new Error("down")))).resolves.toEqual(database);
    await expect(marker()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a marker it cannot read", async () => {
    await mkdir(join(root, FILES_MARKER));
    await expect(verifyFilesFolder(root, facts())).resolves.toEqual({
      ok: false,
      reason: FILES_FOLDER_REASONS.unreadable,
    });
  });

  it.skipIf(asRoot)("refuses a folder it cannot list", async () => {
    await chmod(root, 0o000);
    await expect(verifyFilesFolder(root, facts())).resolves.toEqual({
      ok: false,
      reason: FILES_FOLDER_REASONS.unreadable,
    });
  });

  it.skipIf(asRoot)("refuses a folder it cannot write the marker into", async () => {
    await mkdir(join(root, "alice"));
    await chmod(root, 0o555);
    await expect(verifyFilesFolder(root, facts())).resolves.toEqual({
      ok: false,
      reason: FILES_FOLDER_REASONS.unwritable,
    });
  });

  it("agrees with another process that adopted the folder at the same moment", async () => {
    const racing = facts(false);
    racing.holdsFiles.mockImplementation(async () => {
      await writeFile(join(root, FILES_MARKER), `${ID}\n`);
      return false;
    });
    await expect(verifyFilesFolder(root, racing)).resolves.toEqual({ ok: true, adopted: true });

    await rm(join(root, FILES_MARKER));
    const foreign = facts(false);
    foreign.holdsFiles.mockImplementation(async () => {
      await writeFile(join(root, FILES_MARKER), OTHER);
      return false;
    });
    await expect(verifyFilesFolder(root, foreign)).resolves.toEqual({
      ok: false,
      reason: FILES_FOLDER_REASONS.unwritable,
    });
    expect(await marker()).toBe(OTHER);
  });
});

describe("createFilesFolderGuard", () => {
  function clock() {
    let at = 1_000;
    return { now: () => at, advance: (ms: number) => (at += ms) };
  }

  it("refuses storage until the folder has been checked", () => {
    const guard = createFilesFolderGuard({ root, facts: facts() });
    expect(guard.refusal()).toBe(FILES_FOLDER_REASONS.unchecked);
    let thrown: unknown;
    try {
      guard.assertUsable();
    } catch (error) {
      thrown = error;
    }
    expect(isStorageError(thrown) && thrown.kind).toBe("upstream_unavailable");
  });

  it("answers from the last check until it is stale, one check at a time", async () => {
    const time = clock();
    const known = facts();
    const guard = createFilesFolderGuard({ root, facts: known, now: time.now, recheckMs: 50 });
    const [first, second] = await Promise.all([guard.verify(), guard.verify()]);
    expect(first).toEqual({ ok: true, adopted: true });
    expect(second).toBe(first);
    expect(known.installationId).toHaveBeenCalledOnce();
    expect(guard.refusal()).toBeNull();
    expect(() => guard.assertUsable()).not.toThrow();

    time.advance(49);
    await expect(guard.verify()).resolves.toEqual({ ok: true, adopted: false });
    expect(known.installationId).toHaveBeenCalledOnce();
    time.advance(1);
    await guard.verify();
    expect(known.installationId).toHaveBeenCalledTimes(2);
  });

  it("recovers once the folder is fixed, telling each change once", async () => {
    const time = clock();
    const changes: unknown[] = [];
    const guard = createFilesFolderGuard({
      root,
      facts: facts(true),
      now: time.now,
      recheckMs: 10,
      onChange: (verdict) => changes.push(verdict),
    });
    await guard.verify();
    time.advance(10);
    await guard.verify();
    expect(guard.refusal()).toBe(FILES_FOLDER_REASONS.empty);
    expect(changes).toEqual([{ ok: false, reason: FILES_FOLDER_REASONS.empty }]);

    await mkdir(join(root, "alice"));
    time.advance(10);
    await expect(guard.verify()).resolves.toEqual({ ok: true, adopted: true });
    time.advance(10);
    await guard.verify();
    expect(guard.refusal()).toBeNull();
    expect(changes).toEqual([
      { ok: false, reason: FILES_FOLDER_REASONS.empty },
      { ok: true, adopted: true },
    ]);
  });

  it("keeps a verified folder through a database blip, but not a refused one", async () => {
    const time = clock();
    const known = facts();
    const guard = createFilesFolderGuard({ root, facts: known, now: time.now, recheckMs: 10 });
    await guard.verify();
    known.installationId.mockRejectedValue(new Error("down"));
    time.advance(10);
    await expect(guard.verify()).resolves.toEqual({ ok: true, adopted: false });
    expect(guard.refusal()).toBeNull();

    const unknown = createFilesFolderGuard({ root, facts: facts(false, new Error("down")) });
    await expect(unknown.verify()).resolves.toEqual({
      ok: false,
      reason: FILES_FOLDER_REASONS.database,
    });
    expect(unknown.refusal()).toBe(FILES_FOLDER_REASONS.database);
  });
});
