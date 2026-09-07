import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { rewriteArchive } from "./archive";
import { run } from "./process";

it("preserves byte size and mtime across an equal-length real archive edit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "office-archive-unit-"));
  try {
    const initial = join(directory, "initial.zip");
    await run("python3", [
      "-c",
      "import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n z.writestr('word/document.xml','<p>BEFORE</p>')\n z.writestr('binary.bin',b'BEFORE')",
      initial,
    ]);
    const first = await rewriteArchive(
      directory,
      await readFile(initial),
      "BEFORE",
      "BEFORE",
      1700000000,
    );
    const bytes = await readFile(first);
    const second = await rewriteArchive(directory, bytes, "BEFORE", "AFTER!", 1700000000);
    expect((await readFile(second)).byteLength).toBe(bytes.byteLength);
    expect(Math.floor((await stat(second)).mtimeMs / 1000)).toBe(1700000000);
    expect(
      await run("python3", [
        "-c",
        "import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z:\n print(z.read('word/document.xml').decode())\n print(z.read('binary.bin').decode())",
        second,
      ]),
    ).toBe("<p>AFTER!</p>\nBEFORE\n");
    await expect(rewriteArchive(directory, bytes, "BEFORE", "longer!", 1700000000)).rejects.toThrow(
      "equal byte length",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
