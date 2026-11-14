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
  buildApiEnv,
  buildWebEnvLocal,
  devSeedDir,
  devStorageRoot,
  ENV_FILE_MODE,
  ensureDevFiles,
  ensureEnvFile,
  formatEnv,
  generateMasterKey,
  quoteEnvValue,
  writeEnvFile,
} from "./ensure-env.js";

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ensure-env-test-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("generateMasterKey", () => {
  it("base64-encodes 32 bytes from the injected random source", () => {
    const key = generateMasterKey(() => Buffer.alloc(32, 7));
    expect(Buffer.from(key, "base64")).toEqual(Buffer.alloc(32, 7));
  });

  it("uses the real random source by default and stays 32 bytes long", () => {
    expect(Buffer.from(generateMasterKey(), "base64").length).toBe(32);
  });
});

describe("buildApiEnv", () => {
  it("builds every key the dev stack needs under the given repo root", () => {
    const storageRoot = join("/repo", "deploy", "dev", ".data", "files");
    expect(buildApiEnv("/repo", "the-key")).toEqual({
      PORT: "3001",
      HOST: "127.0.0.1",
      LOG_LEVEL: "debug",
      NODE_ENV: "development",
      DATABASE_URL: "postgres://fdrive:fdrive-dev@127.0.0.1:55432/fdrive",
      FDRIVE_MASTER_KEY: "the-key",
      FDRIVE_COOKIE_SECURE: "false",
      FDRIVE_STORAGE_ROOT: storageRoot,
      FDRIVE_INDEX_ROOTS: JSON.stringify([
        { name: "files", storagePath: storageRoot, indexerPath: "/data" },
      ]),
      FDRIVE_EMBED_URL: "http://127.0.0.1:58012/text",
      FDRIVE_IMAGE_EMBED_URL: "http://127.0.0.1:58012/image",
      FDRIVE_TIKA_URL: "http://127.0.0.1:58012/extract",
      FDRIVE_THUMBS_DIR: join("/repo", "deploy", "dev", ".data", "thumbs"),
      FDRIVE_INDEXER_URL: "http://127.0.0.1:58010",
      FDRIVE_OCR_URL: "http://127.0.0.1:58011",
      FDRIVE_ADMIN_USERS: "dev",
    });
  });

  it("serves the seed's copy, never the committed seed", () => {
    const env = buildApiEnv("/repo", "k");
    expect(env.FDRIVE_STORAGE_ROOT).toBe(devStorageRoot("/repo"));
    expect(devSeedDir("/repo")).toBe(join("/repo", "deploy", "dev", "files"));
    expect(env.FDRIVE_STORAGE_ROOT).not.toBe(devSeedDir("/repo"));
  });

  it("derives URLs from the same port overrides as dev compose", () => {
    const env = {
      FDRIVE_DEV_API_PORT: "3301",
      FDRIVE_DEV_DB_PORT: "55433",
      FDRIVE_DEV_ML_PORT: "59081",
      FDRIVE_DEV_INDEXER_HTTP_PORT: "59010",
      FDRIVE_DEV_OCR_HTTP_PORT: "59011",
    };
    expect(buildApiEnv("/repo", "k", env)).toMatchObject({
      PORT: "3301",
      DATABASE_URL: "postgres://fdrive:fdrive-dev@127.0.0.1:55433/fdrive",
      FDRIVE_EMBED_URL: "http://127.0.0.1:59081/text",
      FDRIVE_IMAGE_EMBED_URL: "http://127.0.0.1:59081/image",
      FDRIVE_TIKA_URL: "http://127.0.0.1:59081/extract",
      FDRIVE_INDEXER_URL: "http://127.0.0.1:59010",
      FDRIVE_OCR_URL: "http://127.0.0.1:59011",
    });
    expect(buildWebEnvLocal(env)).toBe("API_INTERNAL_URL=http://127.0.0.1:3301\n");
  });

  it("rejects a port override that is not a TCP port", () => {
    expect(() => buildWebEnvLocal({ FDRIVE_DEV_API_PORT: "bad" })).toThrow("TCP port");
    expect(() => buildApiEnv("/repo", "k", { FDRIVE_DEV_DB_PORT: "70000" })).toThrow("TCP port");
  });
});

describe("buildWebEnvLocal", () => {
  it("points at the api dev server", () => {
    expect(buildWebEnvLocal()).toBe("API_INTERNAL_URL=http://127.0.0.1:3001\n");
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

describe("formatEnv", () => {
  it("writes one line per key and ends with a newline", () => {
    expect(formatEnv({ A: "1", B: "two words" })).toBe("A=1\nB='two words'\n");
  });

  it("round-trips the api file through node --env-file, in a repo path with a space", () => {
    withTempDir((dir) => {
      const expected = buildApiEnv(join(dir, "my repo"), "a+b/c==");
      const envPath = join(dir, ".env");
      writeFileSync(envPath, formatEnv(expected), "utf-8");
      const keys = JSON.stringify(Object.keys(expected));
      const output = execFileSync(
        process.execPath,
        [
          `--env-file=${envPath}`,
          "-e",
          `console.log(JSON.stringify(Object.fromEntries(${keys}.map((k) => [k, process.env[k]]))))`,
        ],
        // A variable already set wins over the file, so start from none (vitest sets NODE_ENV).
        { encoding: "utf-8", env: {} },
      );
      expect(JSON.parse(output)).toEqual(expected);
    });
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

describe("ensureEnvFile", () => {
  it("writes a missing file, creating its folder, with owner-only permissions (0600)", () => {
    withTempDir((dir) => {
      const path = join(dir, "nested", ".env.local");
      expect(ensureEnvFile({ path, contents: "A=1\n" })).toBe(true);
      expect(readFileSync(path, "utf-8")).toBe("A=1\n");
      expect(statSync(path).mode & 0o777).toBe(ENV_FILE_MODE);
    });
  });

  it("keeps a file that already exists", () => {
    withTempDir((dir) => {
      const path = join(dir, ".env.dev");
      writeFileSync(path, "MINE=1\n");
      expect(ensureEnvFile({ path, contents: "A=1\n" })).toBe(false);
      expect(readFileSync(path, "utf-8")).toBe("MINE=1\n");
    });
  });

  it("writes it again from scratch on reset, at 0600", () => {
    withTempDir((dir) => {
      const path = join(dir, ".env.dev");
      writeFileSync(path, "MINE=1\n", { mode: 0o644 });
      expect(ensureEnvFile({ path, contents: "A=1\n" }, true)).toBe(true);
      expect(readFileSync(path, "utf-8")).toBe("A=1\n");
      expect(statSync(path).mode & 0o777).toBe(ENV_FILE_MODE);
    });
  });

  it("asks the injected check whether the file exists", () => {
    expect(ensureEnvFile({ path: "/anywhere/.env", contents: "A=1\n" }, false, () => true)).toBe(
      false,
    );
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
});
