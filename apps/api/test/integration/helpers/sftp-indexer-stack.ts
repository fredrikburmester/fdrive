import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildSftpgoDump } from "@fdrive/testkit";
import { expect, vi } from "vitest";

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));

async function command(program: string, args: string[], timeout = 30_000): Promise<string> {
  const result = await exec(program, args, { timeout, maxBuffer: 8 * 1024 * 1024 });
  return result.stdout.trim();
}

/** All resources have a unique name. No dev containers or host data are reused. */
export class SftpIndexerStack {
  private readonly prefix = `fdrive-rename-${randomUUID()}`;
  private readonly containers: string[] = [];
  private directory = "";
  private sftpPort = "";
  private networkCreated = false;
  private volumeCreated = false;
  private imageCreated = false;
  connectionString = "";
  sftpgoUrl = "";

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

  async startDatabaseAndStorage(): Promise<void> {
    this.directory = await mkdtemp(join(tmpdir(), "fdrive-rename-"));
    await command("ssh-keygen", [
      "-t",
      "ed25519",
      "-N",
      "",
      "-f",
      join(this.directory, "key"),
      "-q",
    ]);
    const publicKey = (await readFile(join(this.directory, "key.pub"), "utf8")).trim();
    const dump = buildSftpgoDump(
      ["alice", "alice-other"].map((username) => ({
        username,
        password: "disposable-test-password",
        permissions: { "/": ["*"] },
      })),
      [],
      { dataDir: "/srv/sftpgo/data" },
    );
    await writeFile(
      join(this.directory, "seed.json"),
      JSON.stringify({
        ...dump,
        users: dump.users.map((user) => ({ ...user, public_keys: [publicKey] })),
      }),
    );
    // `mkdtemp` creates a 0700 directory. The seed is bind-mounted into the
    // SFTPGo container, which reads it as uid 1000: on a Linux host (CI) it
    // could not open the file, loaded no users, and every login answered 401.
    // Docker Desktop's file sharing masked this on macOS.
    await chmod(this.directory, 0o755);
    await chmod(join(this.directory, "seed.json"), 0o644);
    await this.docker(["network", "create", this.prefix]);
    this.networkCreated = true;
    await this.docker(["volume", "create", this.prefix]);
    this.volumeCreated = true;
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
    await vi.waitFor(
      async () => {
        await this.docker([
          "exec",
          `${this.prefix}-db`,
          "pg_isready",
          "-U",
          "fdrive",
          "-d",
          "fdrive",
        ]);
      },
      { timeout: 60_000, interval: 100 },
    );
    this.connectionString = `postgres://fdrive:disposable-test-password@127.0.0.1:${await this.port("db", 5432)}/fdrive`;
    await this.run("sftp", [
      "-p",
      "127.0.0.1::2022",
      "-p",
      "127.0.0.1::8080",
      "-v",
      `${this.prefix}:/srv/sftpgo/data`,
      "-v",
      `${this.directory}:/seed:ro`,
      "-e",
      "SFTPGO_LOADDATA_FROM=/seed/seed.json",
      "-e",
      "SFTPGO_LOADDATA_MODE=0",
      "drakkan/sftpgo:v2.7.5",
    ]);
    this.sftpPort = await this.port("sftp", 2022);
    this.sftpgoUrl = `http://127.0.0.1:${await this.port("sftp", 8080)}`;
    await vi.waitFor(
      async () => {
        const response = await fetch(`${this.sftpgoUrl}/healthz`, {
          signal: AbortSignal.timeout(2_000),
        });
        expect(response.status).toBe(200);
      },
      { timeout: 60_000, interval: 100 },
    );
    await this.docker([
      "exec",
      "--user",
      "root",
      `${this.prefix}-sftp`,
      "sh",
      "-c",
      "mkdir -p /srv/sftpgo/data/alice/docs/nested /srv/sftpgo/data/alice/docs-other /srv/sftpgo/data/alice-other/docs; " +
        "printf 'first' > /srv/sftpgo/data/alice/docs/top.dat; " +
        "printf 'nested' > /srv/sftpgo/data/alice/docs/nested/child.dat; " +
        "printf 'sibling' > /srv/sftpgo/data/alice/docs-other/keep.dat; " +
        "printf 'other user' > /srv/sftpgo/data/alice-other/docs/top.dat; " +
        "chown -R 1000:1000 /srv/sftpgo/data",
    ]);
    // Pin the host key from this newly created loopback-only test server.
    await vi.waitFor(
      async () => {
        const hostKey = await command("ssh-keyscan", [
          "-T",
          "5",
          "-t",
          "rsa,ecdsa,ed25519",
          "-p",
          this.sftpPort,
          "127.0.0.1",
        ]);
        expect(hostKey).not.toBe("");
        await writeFile(join(this.directory, "known_hosts"), `${hostKey}\n`);
      },
      { timeout: 30_000, interval: 100 },
    );
  }

  async startIndexer(): Promise<void> {
    await this.docker(["build", "-t", this.prefix, join(repoRoot, "services/indexer")], 600_000);
    this.imageCreated = true;
    // Binary fixtures need no extraction or embedding. Only the startup health dependency is stubbed.
    await writeFile(
      join(this.directory, "embed-health.py"),
      [
        "from http.server import BaseHTTPRequestHandler, HTTPServer",
        "class Health(BaseHTTPRequestHandler):",
        "    def do_GET(self):",
        "        self.send_response(200 if self.path == '/health' else 404)",
        "        self.end_headers()",
        "HTTPServer(('0.0.0.0', 8080), Health).serve_forever()",
      ].join("\n"),
    );
    await this.run("embed", [
      "-v",
      `${this.directory}:/fixture:ro`,
      this.prefix,
      "python",
      "/fixture/embed-health.py",
    ]);
    await this.run("indexer", [
      "-v",
      `${this.prefix}:/roots/sftpgo:ro`,
      "-e",
      "DATABASE_URL=postgres://fdrive:disposable-test-password@db:5432/fdrive",
      "-e",
      "INDEX_ROOTS=sftpgo=/roots/sftpgo",
      "-e",
      "EMBED_URL=http://embed:8080",
      "-e",
      "SCAN_INTERVAL_SECONDS=3600",
      "-e",
      "WATCH=true",
      this.prefix,
    ]);
    await vi.waitFor(
      async () => {
        const logs = await this.logs();
        expect(logs).toContain("watching");
        expect(logs).toContain("scan done: 4 files, 4 (re)indexed, 0 deleted, 0 errors");
      },
      { timeout: 60_000, interval: 100 },
    );
  }

  async renameDirectory(): Promise<void> {
    const batch = join(this.directory, "rename.batch");
    await writeFile(batch, 'rename "/docs" "/renamed"\nls "/renamed/nested/child.dat"\n');
    await command("sftp", [
      "-q",
      "-b",
      batch,
      "-P",
      this.sftpPort,
      "-i",
      join(this.directory, "key"),
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${join(this.directory, "known_hosts")}`,
      "alice@127.0.0.1",
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
      this.containers.map((name) => this.docker(["rm", "-f", name])),
    );
    const cleanup = await Promise.allSettled([
      ...(this.volumeCreated ? [this.docker(["volume", "rm", this.prefix])] : []),
      ...(this.networkCreated ? [this.docker(["network", "rm", this.prefix])] : []),
      ...(this.imageCreated ? [this.docker(["image", "rm", this.prefix])] : []),
      ...(this.directory ? [rm(this.directory, { recursive: true, force: true })] : []),
    ]);
    const errors = [...results, ...cleanup].filter((result) => result.status === "rejected");
    if (errors.length)
      throw new AggregateError(
        errors.map((result) => result.reason),
        "Test stack cleanup failed",
      );
  }
}
