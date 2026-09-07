import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { officeFixtureUsers } from "../../api/test/fixtures/office/seeded-users";
import { type RunningEnvironment, startEnvironment } from "../e2e/support/environment";
import { removeStateDirPointer, writeStateDirPointer } from "../e2e/support/paths";
import { fixtureCompose, parsePort, parseProduct } from "./fixture-config";
import { run } from "./process";
import type { OfficeFixtureState } from "./state";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

async function prepareStorage(baseUrl: string, directory: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v2/token`, {
    headers: {
      Authorization: `Basic ${Buffer.from("admin:admin-password-for-tests").toString("base64")}`,
    },
  });
  if (!response.ok) throw new Error(`Fixture admin login failed: ${response.status}`);
  const token = (await response.json()) as { access_token: string };
  const headers = {
    Authorization: `Bearer ${token.access_token}`,
    "Content-Type": "application/json",
  };
  await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(directory, "sftp-key")]);
  const publicKey = await readFile(join(directory, "sftp-key.pub"), "utf8");
  for (const name of ["alice", "bob", "reader"]) {
    const existing = await fetch(`${baseUrl}/api/v2/users/${name}`, { headers });
    if (!existing.ok) throw new Error(`Fixture user ${name} missing`);
    const user = (await existing.json()) as Record<string, unknown>;
    const updated = await fetch(`${baseUrl}/api/v2/users/${name}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        ...user,
        home_dir: "/srv/sftpgo/data/alice",
        public_keys: [publicKey.trim()],
      }),
    });
    if (!updated.ok) throw new Error(`Fixture shared home setup failed: ${updated.status}`);
  }
  const container = (
    await run("docker", [
      "ps",
      "--filter",
      `publish=${new URL(baseUrl).port}`,
      "--format",
      "{{.ID}}",
    ])
  ).trim();
  if (!/^[a-f0-9]{12,64}$/.test(container))
    throw new Error("Could not identify the isolated SFTPGo container");
  return container;
}

export default async function setup(): Promise<() => Promise<void>> {
  const product = parseProduct(process.env.OFFICE_E2E_PRODUCT);
  const apiPort = parsePort(process.env.E2E_API_PORT, 39421);
  const webPort = parsePort(process.env.E2E_WEB_PORT, 39422);
  const officePort = parsePort(
    process.env.OFFICE_E2E_PORT,
    product === "onlyoffice" ? 59490 : 59491,
  );
  if (new Set([apiPort, webPort, officePort]).size !== 3)
    throw new Error("Office fixture ports must be distinct");
  process.env.E2E_API_PORT = String(apiPort);
  process.env.E2E_WEB_PORT = String(webPort);
  const directory = await mkdtemp(join(tmpdir(), "fdrive-office-e2e-"));
  process.env.E2E_STATE_DIR = directory;
  writeStateDirPointer(process.pid, directory);
  const project = `fdrive-office-e2e-${randomBytes(5).toString("hex")}`;
  const composeFile = join(directory, "compose.json");
  await writeFile(
    composeFile,
    JSON.stringify(
      fixtureCompose(
        join(repo, "deploy/office/compose.services.yaml"),
        product,
        officePort,
        apiPort,
        webPort,
      ),
    ),
    { mode: 0o600 },
  );
  const composeArgs = ["compose", "-p", project, "-f", composeFile];
  const composeEnv = { ...process.env, ONLYOFFICE_JWT_SECRET: randomBytes(32).toString("hex") };
  let environment: RunningEnvironment | undefined;
  const cleanup = async () => {
    try {
      await environment?.stop();
    } finally {
      try {
        await run("docker", [...composeArgs, "down", "--volumes", "--remove-orphans"], {
          env: composeEnv,
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
        removeStateDirPointer(process.pid);
      }
    }
  };
  try {
    await run("docker", [...composeArgs, "up", "-d", "--wait", "--wait-timeout", "360"], {
      env: composeEnv,
      timeout: 420_000,
    });
    const officeUrl = `http://127.0.0.1:${officePort}`;
    const webUrl = `http://127.0.0.1:${webPort}`;
    let sftpgoContainer = "";
    environment = await startEnvironment({
      apiEntrypoint: "test/fixtures/office/e2e-server.ts",
      sftpgoOptions: {
        users: officeFixtureUsers,
        files: { alice: { "/fixture.txt": "isolated office fixture" } },
        folders: [],
      },
      prepareSftpgo: async (baseUrl) => {
        sftpgoContainer = await prepareStorage(baseUrl, directory);
      },
      extraApiEnv: {
        HOST: "0.0.0.0",
        FDRIVE_PUBLIC_URL: webUrl,
        FDRIVE_OFFICE_PRODUCT: product,
        FDRIVE_OFFICE_URL: officeUrl,
        FDRIVE_OFFICE_PUBLIC_URL: officeUrl,
        FDRIVE_WOPI_URL: `http://host.docker.internal:${apiPort}/wopi`,
        FDRIVE_HOME_TEMPLATE: "sftpgo:/alice",
        FDRIVE_INDEX_ROOTS: JSON.stringify([
          { name: "sftpgo", sftpgoPath: "/srv/sftpgo/data", indexerPath: "/roots/sftpgo" },
        ]),
      },
    });
    const state: OfficeFixtureState = {
      product,
      webUrl,
      apiUrl: `http://127.0.0.1:${apiPort}`,
      officeUrl,
      officeContainer: `${project}-${product}-1`,
      sftpgoUrl: environment.sftpgoUrl,
      sftpgoContainer,
      directory,
    };
    await writeFile(join(directory, "office.json"), JSON.stringify(state), { mode: 0o600 });
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
