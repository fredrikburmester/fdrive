import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createDb, createFilesFolderFacts } from "@fdrive/db";
import { verifyFilesFolder } from "@fdrive/local";
import { type LocalStorageFixture, startLocalStorage } from "@fdrive/testkit";
import { expect, vi } from "vitest";

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
/** Where every container sees the local folder, as `FDRIVE_INDEX_ROOTS`' `indexerPath` would. */
const ROOT_IN_CONTAINER = "/roots/files";

async function command(program: string, args: string[], timeout = 30_000): Promise<string> {
  const result = await exec(program, args, { timeout, maxBuffer: 8 * 1024 * 1024 });
  return result.stdout.trim();
}

/** Lets every uid read `path` and, for folders, enter it: the indexer runs as uid 1000. */
async function openForReading(path: string): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true });
  await chmod(path, 0o755);
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await openForReading(child);
    else await chmod(child, 0o644);
  }
}

/**
 * A local folder on this machine, a migrated-to Postgres and the real
 * indexer watching that folder, the way a deployment mounts its files folder
 * into the indexer. All resources have a unique name. No dev containers or
 * host data are reused.
 */
export class LocalIndexerStack {
  private readonly prefix = `fdrive-rename-${randomUUID()}`;
  private readonly containers: string[] = [];
  private directory = "";
  private networkCreated = false;
  private imageCreated = false;
  storage: LocalStorageFixture | undefined;
  connectionString = "";

  private docker(args: string[], timeout?: number): Promise<string> {
    return command("docker", args, timeout);
  }

  private async run(name: string, args: string[]): Promise<void> {
    const container = `${this.prefix}-${name}`;
    this.containers.push(container);
    await this.docker([
      "run",
      "--detach",
      "--name",
      container,
      "--network",
      this.prefix,
      "--network-alias",
      name,
      ...args,
    ]);
  }

  private async port(name: string, port: number): Promise<string> {
    const published = await this.docker(["port", `${this.prefix}-${name}`, `${port}/tcp`]);
    const value = published.split(":").at(-1);
    if (!value || !/^\d+$/.test(value)) throw new Error(`Invalid Docker port: ${published}`);
    return value;
  }

  /** The local folder, for the storage the listener checks moves against. */
  get folder(): LocalStorageFixture {
    if (this.storage === undefined) throw new Error("the local folder has not been laid out");
    return this.storage;
  }

  async startDatabaseAndStorage(): Promise<void> {
    this.directory = await mkdtemp(join(tmpdir(), "fdrive-rename-"));
    // `mkdtemp` creates 0700 folders. Containers read these as another uid:
    // on a Linux host (CI) they could not, and Docker Desktop's file sharing
    // masks that on macOS.
    await chmod(this.directory, 0o755);
    this.storage = await startLocalStorage({
      users: ["alice", "alice-other"].map((username) => ({
        username,
        password: "disposable-test-password",
      })),
      files: {
        alice: {
          "/docs/top.dat": "first",
          "/docs/nested/child.dat": "nested",
          "/docs-other/keep.dat": "sibling",
        },
        "alice-other": { "/docs/top.dat": "other user" },
      },
    });
    await openForReading(this.storage.root);
    await this.docker(["network", "create", this.prefix]);
    this.networkCreated = true;
    await this.run("db", [
      "-p",
      "127.0.0.1::5432",
      "-e",
      "POSTGRES_DB=fdrive",
      "-e",
      "POSTGRES_USER=fdrive",
      "-e",
      "POSTGRES_PASSWORD=disposable-test-password",
      "pgvector/pgvector:pg17",
    ]);
    // Over TCP: the image's first-start server listens only on its socket
    // and is restarted after init, so a socket check passes too early.
    await vi.waitFor(
      async () => {
        await this.docker([
          "exec",
          `${this.prefix}-db`,
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          "fdrive",
          "-d",
          "fdrive",
        ]);
      },
      { timeout: 60_000, interval: 100 },
    );
    this.connectionString = `postgres://fdrive:disposable-test-password@127.0.0.1:${await this.port("db", 5432)}/fdrive`;
  }

  /**
   * Starts the indexer and waits for its first scan. Without `watch`, only
   * the API's queue (and scans) can tell it about a change.
   */
  async startIndexer(options: { readonly watch?: boolean } = {}): Promise<void> {
    const watch = options.watch ?? true;
    // The API marks the files folder as this installation's when it starts;
    // the indexer touches no folder without that marker. Needs the migrations.
    const marking = createDb(this.connectionString);
    try {
      const verdict = await verifyFilesFolder(this.folder.root, createFilesFolderFacts(marking.db));
      if (!verdict.ok) throw new Error(verdict.reason);
    } finally {
      await marking.close();
    }
    // A first build compiles MuPDF from source, which takes several minutes.
    await this.docker(["build", "-t", this.prefix, join(repoRoot, "services/indexer")], 1_800_000);
    this.imageCreated = true;
    // Binary fixtures need no extraction or embedding, so no ml service is started.
    // Writers outside fdrive (rsync, Syncthing, a shell) change the folder in
    // place; this container is one, sharing the folder with the indexer.
    await this.run("writer", [
      "-v",
      `${this.folder.root}:${ROOT_IN_CONTAINER}`,
      this.prefix,
      "sleep",
      "infinity",
    ]);
    await this.run("indexer", [
      "-v",
      `${this.folder.root}:${ROOT_IN_CONTAINER}:ro`,
      "-e",
      "DATABASE_URL=postgres://fdrive:disposable-test-password@db:5432/fdrive",
      "-e",
      `INDEX_ROOTS=files=${ROOT_IN_CONTAINER}`,
      "-e",
      "SCAN_INTERVAL_SECONDS=3600",
      "-e",
      `WATCH=${watch}`,
      this.prefix,
    ]);
    await vi.waitFor(
      async () => {
        const logs = await this.logs();
        if (watch) expect(logs).toContain("watching");
        expect(logs).toContain("scan done: 4 files, 4 (re)indexed, 0 deleted, 0 errors");
      },
      { timeout: 60_000, interval: 100 },
    );
  }

  /** Renames alice's `/docs` to `/renamed` on disk, outside fdrive. */
  async renameDirectory(): Promise<void> {
    await this.docker([
      "exec",
      "--user",
      "root",
      `${this.prefix}-writer`,
      "mv",
      `${ROOT_IN_CONTAINER}/alice/docs`,
      `${ROOT_IN_CONTAINER}/alice/renamed`,
    ]);
  }

  async logs(): Promise<string> {
    const result = await exec("docker", ["logs", `${this.prefix}-indexer`], {
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return result.stdout + result.stderr;
  }

  async stop(): Promise<void> {
    const results = await Promise.allSettled(
      this.containers.map((name) => this.docker(["rm", "-f", "-v", name])),
    );
    const cleanup = await Promise.allSettled([
      ...(this.networkCreated ? [this.docker(["network", "rm", this.prefix])] : []),
      ...(this.imageCreated ? [this.docker(["image", "rm", this.prefix])] : []),
      ...(this.directory ? [rm(this.directory, { recursive: true, force: true })] : []),
      ...(this.storage ? [this.storage.stop()] : []),
    ]);
    const errors = [...results, ...cleanup].filter((result) => result.status === "rejected");
    if (errors.length)
      throw new AggregateError(
        errors.map((result) => result.reason),
        "Test stack cleanup failed",
      );
  }
}
