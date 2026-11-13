import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildApiEnvDev,
  buildDevSearchEnv,
  buildWebEnvLocal,
  devSeedDir,
  devStorageRoot,
  ENV_FILE_MODE,
  ensureDevFiles,
  ensureEnvFile,
  generateMasterKey,
  isObsoleteApiEnvLine,
  planApiEnvDev,
  quoteEnvValue,
  upsertEnv,
  writeEnvFile,
} from "./ensure-env.js";

describe("generateMasterKey", () => {
  it("base64-encodes 32 bytes from the injected random source", () => {
    const key = generateMasterKey(() => Buffer.alloc(32, 7));
    expect(Buffer.from(key, "base64")).toEqual(Buffer.alloc(32, 7));
  });

  it("uses the real random source by default and stays 32 bytes long", () => {
    expect(Buffer.from(generateMasterKey(), "base64").length).toBe(32);
  });
});

describe("buildApiEnvDev", () => {
  it("includes the master key and ends with a trailing newline", () => {
    const contents = buildApiEnvDev("the-key");
    expect(contents).toContain("FDRIVE_MASTER_KEY=the-key");
    expect(contents.endsWith("\n")).toBe(true);
  });

  it("names no SFTPGo server or home template", () => {
    const contents = buildApiEnvDev("the-key");
    expect(contents).not.toContain("SFTPGO_URL");
    expect(contents).not.toContain("FDRIVE_HOME_TEMPLATE");
  });
});

describe("buildWebEnvLocal", () => {
  it("points at the api dev server", () => {
    expect(buildWebEnvLocal()).toBe("API_INTERNAL_URL=http://127.0.0.1:3001\n");
  });
});

describe("buildDevSearchEnv", () => {
  it("builds every search, OCR, and thumbnails key under the given repo root", () => {
    const additions = buildDevSearchEnv("/repo");
    expect(additions.FDRIVE_EMBED_URL).toBe("http://127.0.0.1:58012/text");
    expect(additions.FDRIVE_INDEXER_URL).toBe("http://127.0.0.1:58010");
    expect(additions.FDRIVE_OCR_URL).toBe("http://127.0.0.1:58011");
    expect(additions.FDRIVE_IMAGE_EMBED_URL).toBe("http://127.0.0.1:58012/image");
    expect(additions.FDRIVE_TIKA_URL).toBe("http://127.0.0.1:58012/extract");
    expect(additions.FDRIVE_ADMIN_USERS).toBe("dev");
    expect(additions.FDRIVE_THUMBS_DIR).toBe(join("/repo", "deploy", "dev", ".data", "thumbs"));
    expect(additions.FDRIVE_STORAGE_ROOT).toBe(join("/repo", "deploy", "dev", ".data", "files"));
    expect(JSON.parse(additions.FDRIVE_INDEX_ROOTS ?? "")).toEqual([
      {
        name: "files",
        storagePath: join("/repo", "deploy", "dev", ".data", "files"),
        indexerPath: "/data",
      },
    ]);
  });

  it("indexes the served folder under the root the dev indexer mounts", () => {
    const additions = buildDevSearchEnv("/repo");
    const [root] = JSON.parse(additions.FDRIVE_INDEX_ROOTS ?? "[]");
    expect(root.storagePath).toBe(additions.FDRIVE_STORAGE_ROOT);
    expect(devStorageRoot("/repo")).toBe(additions.FDRIVE_STORAGE_ROOT);
    expect(devSeedDir("/repo")).toBe(join("/repo", "deploy", "dev", "files"));
  });

  it("returns every documented processing key", () => {
    expect(Object.keys(buildDevSearchEnv("/repo")).sort()).toEqual(
      [
        "FDRIVE_ADMIN_USERS",
        "FDRIVE_EMBED_URL",
        "FDRIVE_INDEXER_URL",
        "FDRIVE_INDEX_ROOTS",
        "FDRIVE_OCR_URL",
        "FDRIVE_IMAGE_EMBED_URL",
        "FDRIVE_STORAGE_ROOT",
        "FDRIVE_THUMBS_DIR",
        "FDRIVE_TIKA_URL",
      ].sort(),
    );
  });
});

describe("quoteEnvValue", () => {
  it("leaves a plain URL unquoted", () => {
    expect(quoteEnvValue("http://127.0.0.1:58081")).toBe("http://127.0.0.1:58081");
  });

  it("leaves a bare word like an admin username unquoted", () => {
    expect(quoteEnvValue("dev")).toBe("dev");
  });

  it("single-quotes a JSON value containing double quotes", () => {
    const value = '[{"a":1}]';
    expect(quoteEnvValue(value)).toBe(`'${value}'`);
  });

  it("double-quotes a value that itself contains a single quote", () => {
    const value = "it's here";
    expect(quoteEnvValue(value)).toBe(`"${value}"`);
  });
});

describe("upsertEnv", () => {
  it("appends every key from an empty file", () => {
    const result = upsertEnv("", { A: "1", B: "2" });
    expect(result).toBe("A=1\nB=2\n");
  });

  it("does not duplicate or alter an already-present key", () => {
    const before = "A=original\n";
    const result = upsertEnv(before, { A: "new", B: "2" });
    expect(result).toBe("A=original\nB=2\n");
  });

  it("returns the same reference when nothing is missing", () => {
    const before = "A=1\nB=2\n";
    expect(upsertEnv(before, { A: "1", B: "2" })).toBe(before);
  });

  it("is idempotent: applying it twice matches applying it once", () => {
    const once = upsertEnv("A=1\n", { A: "1", B: "2", C: "3" });
    const twice = upsertEnv(once, { A: "1", B: "2", C: "3" });
    expect(twice).toBe(once);
  });

  it("adds a trailing newline to a file missing one before appending", () => {
    const result = upsertEnv("A=1", { B: "2" });
    expect(result).toBe("A=1\nB=2\n");
  });

  it("quotes JSON-shaped additions so they round-trip through node --env-file", () => {
    const additions = buildDevSearchEnv("/repo");
    const contents = upsertEnv("", additions);
    const dir = mkdtempSync(join(tmpdir(), "ensure-env-test-"));
    const envPath = join(dir, ".env");
    try {
      writeFileSync(envPath, contents, "utf-8");
      const output = execFileSync(
        process.execPath,
        [
          `--env-file=${envPath}`,
          "-e",
          "console.log(JSON.stringify(process.env.FDRIVE_INDEX_ROOTS))",
        ],
        { encoding: "utf-8" },
      );
      expect(JSON.parse(JSON.parse(output))).toEqual([
        {
          name: "files",
          storagePath: join("/repo", "deploy", "dev", ".data", "files"),
          indexerPath: "/data",
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("planApiEnvDev", () => {
  it("generates a fresh file (including the additions) when none exists yet", () => {
    const plan = planApiEnvDev(undefined, { FDRIVE_ADMIN_USERS: "dev" }, "the-key");
    expect(plan.contents).toContain("FDRIVE_MASTER_KEY=the-key");
    expect(plan.contents).toContain("FDRIVE_ADMIN_USERS=dev");
    expect(plan.addedKeys).toEqual(["FDRIVE_ADMIN_USERS"]);
  });

  it("upserts only the missing keys into an existing file, reporting just those", () => {
    const existing = "PORT=3001\nFDRIVE_ADMIN_USERS=custom\n";
    const plan = planApiEnvDev(
      existing,
      { FDRIVE_ADMIN_USERS: "dev", FDRIVE_EMBED_URL: "http://127.0.0.1:58081" },
      "unused-key",
    );
    expect(plan.contents).toBe(
      "PORT=3001\nFDRIVE_ADMIN_USERS=custom\nFDRIVE_EMBED_URL=http://127.0.0.1:58081\n",
    );
    expect(plan.addedKeys).toEqual(["FDRIVE_EMBED_URL"]);
  });

  it("reports no added keys when the existing file already has everything", () => {
    const existing = "A=1\nB=2\n";
    const plan = planApiEnvDev(existing, { A: "ignored", B: "ignored" }, "unused-key");
    expect(plan.addedKeys).toEqual([]);
    expect(plan.removedKeys).toEqual([]);
    expect(plan.contents).toBe(existing);
  });
});

describe("planApiEnvDev with the seed folder", () => {
  it("moves a storage root that served the committed seed onto its copy", () => {
    const seed = devSeedDir("/repo");
    const roots = JSON.stringify([{ name: "files", storagePath: seed, indexerPath: "/data" }]);
    const existing = [
      "FDRIVE_MASTER_KEY=kept",
      `FDRIVE_STORAGE_ROOT=${seed}`,
      `FDRIVE_INDEX_ROOTS=${quoteEnvValue(roots)}`,
      "",
    ].join("\n");
    const additions = buildDevSearchEnv("/repo");
    const plan = planApiEnvDev(existing, additions, "unused-key", {}, seed);
    expect(plan.addedKeys).toEqual(
      expect.arrayContaining(["FDRIVE_STORAGE_ROOT", "FDRIVE_INDEX_ROOTS"]),
    );
    expect(plan.removedKeys).toEqual([]);
    expect(plan.contents).toContain(`FDRIVE_STORAGE_ROOT=${devStorageRoot("/repo")}\n`);
    expect(plan.contents).not.toContain(`${seed}"`);
    expect(plan.contents).not.toContain(`=${seed}\n`);
    expect(plan.contents).toContain("FDRIVE_MASTER_KEY=kept");
  });

  it("keeps a storage root the developer chose", () => {
    const existing = "FDRIVE_STORAGE_ROOT=/elsewhere\n";
    const plan = planApiEnvDev(existing, buildDevSearchEnv("/repo"), "k", {}, devSeedDir("/repo"));
    expect(plan.contents).toContain("FDRIVE_STORAGE_ROOT=/elsewhere\n");
    expect(plan.addedKeys).not.toContain("FDRIVE_STORAGE_ROOT");
  });
});

describe("ensureDevFiles", () => {
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "ensure-dev-files-"));
    const seed = join(dir, "seed");
    mkdirSync(join(seed, "dev", "notes"), { recursive: true });
    writeFileSync(join(seed, "dev", "notes", "todo.md"), "seed");
    return { dir, seed, files: join(dir, ".data", "files") };
  }

  it("copies the seed when the served folder is missing", () => {
    const f = fixture();
    try {
      expect(ensureDevFiles(f.seed, f.files)).toBe(true);
      expect(readFileSync(join(f.files, "dev", "notes", "todo.md"), "utf-8")).toBe("seed");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("copies into an empty folder, like one Docker created first", () => {
    const f = fixture();
    try {
      mkdirSync(f.files, { recursive: true });
      expect(ensureDevFiles(f.seed, f.files)).toBe(true);
      expect(readdirSync(f.files)).toEqual(["dev"]);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("keeps what dev use changed, and never writes to the seed", () => {
    const f = fixture();
    try {
      ensureDevFiles(f.seed, f.files);
      writeFileSync(join(f.files, "dev", "notes", "todo.md"), "edited");
      writeFileSync(join(f.files, "dev", "upload.txt"), "new");
      expect(ensureDevFiles(f.seed, f.files)).toBe(false);
      expect(readFileSync(join(f.files, "dev", "notes", "todo.md"), "utf-8")).toBe("edited");
      expect(readFileSync(join(f.seed, "dev", "notes", "todo.md"), "utf-8")).toBe("seed");
      expect(existsSync(join(f.seed, "dev", "upload.txt"))).toBe(false);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("starts from a fresh copy on reset", () => {
    const f = fixture();
    try {
      ensureDevFiles(f.seed, f.files);
      writeFileSync(join(f.files, "dev", "notes", "todo.md"), "edited");
      writeFileSync(join(f.files, "dev", "upload.txt"), "new");
      expect(ensureDevFiles(f.seed, f.files, true)).toBe(true);
      expect(readFileSync(join(f.files, "dev", "notes", "todo.md"), "utf-8")).toBe("seed");
      expect(existsSync(join(f.files, "dev", "upload.txt"))).toBe(false);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});

describe("isObsoleteApiEnvLine", () => {
  it("matches nothing without the seed folder", () => {
    expect(isObsoleteApiEnvLine("FDRIVE_STORAGE_ROOT=/repo/deploy/dev/files")).toBe(false);
    expect(isObsoleteApiEnvLine(`FDRIVE_INDEX_ROOTS='[{"name":"mine"}]'`)).toBe(false);
    expect(isObsoleteApiEnvLine("# FDRIVE_STORAGE_ROOT=commented", "/x")).toBe(false);
    expect(isObsoleteApiEnvLine("", "/x")).toBe(false);
  });

  it("given the seed folder, matches only values that serve it", () => {
    const seed = "/repo/deploy/dev/files";
    const roots = (path: string) =>
      `FDRIVE_INDEX_ROOTS=${quoteEnvValue(JSON.stringify([{ name: "files", storagePath: path, indexerPath: "/data" }]))}`;
    expect(isObsoleteApiEnvLine(`FDRIVE_STORAGE_ROOT=${seed}`, seed)).toBe(true);
    expect(isObsoleteApiEnvLine(`FDRIVE_STORAGE_ROOT="${seed}"`, seed)).toBe(true);
    expect(isObsoleteApiEnvLine(`FDRIVE_STORAGE_ROOT=${seed}`)).toBe(false);
    expect(isObsoleteApiEnvLine("FDRIVE_STORAGE_ROOT=/repo/deploy/dev/.data/files", seed)).toBe(
      false,
    );
    expect(isObsoleteApiEnvLine(roots(seed), seed)).toBe(true);
    expect(isObsoleteApiEnvLine(roots("/mine"), seed)).toBe(false);
    expect(isObsoleteApiEnvLine("FDRIVE_INDEX_ROOTS=not-json", seed)).toBe(false);
    expect(isObsoleteApiEnvLine(`FDRIVE_INDEX_ROOTS='{"storagePath":"${seed}"}'`, seed)).toBe(
      false,
    );
    expect(isObsoleteApiEnvLine(`FDRIVE_INDEX_ROOTS='[1,null]'`, seed)).toBe(false);
    expect(isObsoleteApiEnvLine("FDRIVE_THUMBS_DIR=/x", seed)).toBe(false);
  });
});

describe("ensureEnvFile", () => {
  it("writes the file and returns true when nothing exists at the path", () => {
    const dir = mkdtempSync(join(tmpdir(), "ensure-env-file-test-"));
    try {
      const path = join(dir, "nested", ".env.local");
      const wrote = ensureEnvFile({ path, contents: "A=1\n" });
      expect(wrote).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns false and does not call the writer when the file already exists", () => {
    const wrote = ensureEnvFile({ path: "/anywhere/.env", contents: "A=1\n" }, () => true);
    expect(wrote).toBe(false);
  });

  it("creates the file with owner-only permissions (0600)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ensure-env-file-mode-test-"));
    try {
      const path = join(dir, ".env.local");
      ensureEnvFile({ path, contents: "A=1\n" });
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(ENV_FILE_MODE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("writeEnvFile", () => {
  it("writes with mode 0600 and follows up with an explicit chmodSync to the same mode", () => {
    const writeFileSyncSpy = vi.fn();
    const chmodSyncSpy = vi.fn();
    writeEnvFile("/some/.env", "A=1\n", {
      writeFileSync: writeFileSyncSpy,
      chmodSync: chmodSyncSpy,
    });
    expect(writeFileSyncSpy).toHaveBeenCalledWith("/some/.env", "A=1\n", {
      encoding: "utf-8",
      mode: ENV_FILE_MODE,
    });
    expect(chmodSyncSpy).toHaveBeenCalledWith("/some/.env", ENV_FILE_MODE);
  });

  it("against the real filesystem, leaves an existing, loosely-permissioned file at 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "write-env-file-test-"));
    try {
      const path = join(dir, ".env");
      writeFileSync(path, "A=1\n", { mode: 0o644 });
      expect(statSync(path).mode & 0o777).toBe(0o644);

      writeEnvFile(path, "A=1\nB=2\n");

      expect(statSync(path).mode & 0o777).toBe(ENV_FILE_MODE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

it("derives URLs from the same port overrides as dev compose", () => {
  const env = {
    FDRIVE_DEV_API_PORT: "3301",
    FDRIVE_DEV_DB_PORT: "55433",
    FDRIVE_DEV_ML_PORT: "59081",
    FDRIVE_DEV_INDEXER_HTTP_PORT: "59010",
    FDRIVE_DEV_OCR_HTTP_PORT: "59011",
  };
  const api = buildApiEnvDev("key", env);
  expect(api).toContain("PORT=3301");
  expect(api).toContain("127.0.0.1:55433/fdrive");
  expect(buildWebEnvLocal(env)).toContain("127.0.0.1:3301");
  expect(buildDevSearchEnv("/repo", env)).toMatchObject({
    FDRIVE_EMBED_URL: "http://127.0.0.1:59081/text",
    FDRIVE_INDEXER_URL: "http://127.0.0.1:59010",
    FDRIVE_OCR_URL: "http://127.0.0.1:59011",
    FDRIVE_IMAGE_EMBED_URL: "http://127.0.0.1:59081/image",
    FDRIVE_TIKA_URL: "http://127.0.0.1:59081/extract",
  });
  expect(() => buildWebEnvLocal({ FDRIVE_DEV_API_PORT: "bad" })).toThrow("TCP port");
});
