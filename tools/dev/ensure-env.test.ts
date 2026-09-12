import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildApiEnvDev,
  buildDevSearchEnv,
  buildWebEnvLocal,
  ENV_FILE_MODE,
  ensureEnvFile,
  generateMasterKey,
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
});

describe("buildWebEnvLocal", () => {
  it("points at the api dev server", () => {
    expect(buildWebEnvLocal()).toBe("API_INTERNAL_URL=http://127.0.0.1:3001\n");
  });
});

describe("buildDevSearchEnv", () => {
  it("builds every search, OCR, and thumbnails key under the given repo root", () => {
    const additions = buildDevSearchEnv("/repo");
    expect(additions.FDRIVE_EMBED_URL).toBe("http://127.0.0.1:58081");
    expect(additions.FDRIVE_INDEXER_URL).toBe("http://127.0.0.1:58010");
    expect(additions.FDRIVE_OCR_URL).toBe("http://127.0.0.1:58011");
    expect(additions.FDRIVE_IMAGE_EMBED_URL).toBe("http://127.0.0.1:58012");
    expect(additions.FDRIVE_ADMIN_USERS).toBe("dev");
    expect(additions.FDRIVE_THUMBS_DIR).toBe(join("/repo", "deploy", "dev", ".data", "thumbs"));
    expect(JSON.parse(additions.FDRIVE_INDEX_ROOTS ?? "")).toEqual([
      { name: "sftpgo", sftpgoPath: "/srv/sftpgo/data", indexerPath: "/roots/sftpgo" },
    ]);
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
        { name: "sftpgo", sftpgoPath: "/srv/sftpgo/data", indexerPath: "/roots/sftpgo" },
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
    expect(plan.contents).toBe(existing);
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
    FDRIVE_DEV_SFTPGO_HTTP_PORT: "58083",
    FDRIVE_DEV_EMBED_PORT: "59081",
    FDRIVE_DEV_INDEXER_HTTP_PORT: "59010",
    FDRIVE_DEV_OCR_HTTP_PORT: "59011",
    FDRIVE_DEV_IMAGE_EMBED_PORT: "59012",
    FDRIVE_DEV_TIKA_PORT: "59999",
  };
  const api = buildApiEnvDev("key", env);
  expect(api).toContain("PORT=3301");
  expect(api).toContain("127.0.0.1:55433/fdrive");
  expect(api).toContain("SFTPGO_URL=http://127.0.0.1:58083");
  expect(buildWebEnvLocal(env)).toContain("127.0.0.1:3301");
  expect(buildDevSearchEnv("/repo", env)).toMatchObject({
    FDRIVE_EMBED_URL: "http://127.0.0.1:59081",
    FDRIVE_INDEXER_URL: "http://127.0.0.1:59010",
    FDRIVE_OCR_URL: "http://127.0.0.1:59011",
    FDRIVE_IMAGE_EMBED_URL: "http://127.0.0.1:59012",
    FDRIVE_TIKA_URL: "http://127.0.0.1:59999",
  });
  expect(() => buildWebEnvLocal({ FDRIVE_DEV_API_PORT: "bad" })).toThrow("TCP port");
});
