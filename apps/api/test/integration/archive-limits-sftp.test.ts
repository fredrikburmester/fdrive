import { startPostgres, startSftpgo } from "@fdrive/testkit";
import type { Logger } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZipFile } from "yazl";
import { composeApp } from "../../src/composition.js";
import { loadConfig } from "../../src/config.js";

function zipContent(content: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = new ZipFile();
    const chunks: Buffer[] = [];
    archive.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.outputStream.once("error", reject);
    archive.outputStream.once("end", () => resolve(Buffer.concat(chunks)));
    archive.addBuffer(Buffer.from(content), "note.txt");
    archive.end();
  });
}

describe("archive expansion limits against real SFTPGo", () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let sftp: Awaited<ReturnType<typeof startSftpgo>>;
  let composed: Awaited<ReturnType<typeof composeApp>>;
  let cookie: string;

  beforeAll(async () => {
    [postgres, sftp] = await Promise.all([
      startPostgres(),
      startSftpgo({
        users: [{ username: "alice", password: "alice-pass", permissions: { "/": ["*"] } }],
        folders: [],
        files: {},
      }),
    ]);
    const noop = () => undefined;
    composed = await composeApp(
      loadConfig({
        DATABASE_URL: postgres.connectionString,
        SFTPGO_URL: sftp.baseUrl,
        FDRIVE_MASTER_KEY: Buffer.alloc(32, 17).toString("base64"),
        FDRIVE_JOB_MAX_BYTES: "1000",
      }),
      { info: noop, warn: noop, error: noop } as unknown as Logger,
    );
    const login = await composed.app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "x-requested-with": "fdrive", "content-type": "application/json" },
      body: JSON.stringify({ credential: { username: "alice", password: "alice-pass" } }),
    });
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(cookie).not.toBe("");
  }, 180_000);

  afterAll(async () => {
    await composed?.close();
    await sftp?.stop();
    await postgres?.stop();
  }, 180_000);

  async function extract(name: string, content: string) {
    const archive = await zipContent(content);
    expect(archive.length).toBeLessThan(1000);
    const upload = await composed.app.request(`/api/v1/fs/upload?path=/${name}.zip`, {
      method: "PUT",
      headers: { cookie, "x-requested-with": "fdrive" },
      body: new Uint8Array(archive),
    });
    expect(upload.status).toBe(201);
    const request = await composed.app.request("/api/v1/fs/extract", {
      method: "POST",
      headers: { cookie, "x-requested-with": "fdrive", "content-type": "application/json" },
      body: JSON.stringify({ path: `/${name}.zip` }),
    });
    expect(request.status).toBe(202);
    const { jobId } = (await request.json()) as { jobId: string };
    return async () => {
      const response = await composed.app.request(`/api/v1/fs/jobs/${jobId}`, {
        headers: { cookie },
      });
      expect(response.status).toBe(200);
      return response.json();
    };
  }

  it("extracts small content but fails a compressed expansion before writing its output", async () => {
    const smallJob = await extract("small", "small content");
    await expect.poll(smallJob, { timeout: 10_000 }).toMatchObject({ state: "done" });
    const smallFile = await composed.app.request("/api/v1/fs/download?path=/small/note.txt", {
      headers: { cookie },
    });
    expect(smallFile.status).toBe(200);
    expect(await smallFile.text()).toBe("small content");

    const oversizedJob = await extract("oversized", "x".repeat(20_000));
    await expect.poll(oversizedJob, { timeout: 10_000 }).toMatchObject({
      state: "failed",
      error: "exceeded the maximum of 1000 bytes allowed for this job",
    });
    const output = await composed.app.request("/api/v1/fs/stat?path=/oversized/note.txt", {
      headers: { cookie },
    });
    expect(output.status).toBe(404);
  });
});
