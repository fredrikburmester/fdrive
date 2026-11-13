import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { officeFixtureUsers } from "../../api/test/fixtures/office/seeded-users";
import { type RunningEnvironment, startEnvironment } from "../e2e/support/environment";
import { removeStateDirPointer, writeStateDirPointer } from "../e2e/support/paths";
import { waitForHttpOk } from "../e2e/support/wait";
import { fixtureCompose, OFFICE_TEAM_FOLDER, parsePort, parseProduct } from "./fixture-config";
import { run } from "./process";
import type { OfficeFixtureState } from "./state";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * The fixture's local folder: a home per Office user, alice's fixture file,
 * and her team folder, which bob may edit and reader may only view. The
 * coauthoring specs open alice's documents there, so every user reaches the
 * same file (one Office file ID) through their own login.
 */
const OFFICE_STORAGE = {
  users: officeFixtureUsers.map(({ username, password }) => ({ username, password })),
  files: { alice: { "/fixture.txt": "isolated office fixture" } },
  grants: [
    { owner: "alice", path: `/${OFFICE_TEAM_FOLDER}`, grantee: "bob", access: "write" },
    { owner: "alice", path: `/${OFFICE_TEAM_FOLDER}`, grantee: "reader", access: "read" },
  ],
} as const;

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
  const workerToken = randomBytes(32).toString("hex");
  await writeFile(
    composeFile,
    JSON.stringify(
      fixtureCompose(
        join(repo, "deploy/office/compose.services.yaml"),
        product,
        officePort,
        apiPort,
        webPort,
        workerToken,
      ),
    ),
    { mode: 0o600 },
  );
  const composeArgs = ["compose", "-p", project, "-f", composeFile];
  const composeEnv = { ...process.env };
  let environment: RunningEnvironment | undefined;
  const previousOfficePublicUrl = process.env.FDRIVE_OFFICE_PUBLIC_URL;
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
        if (previousOfficePublicUrl === undefined) delete process.env.FDRIVE_OFFICE_PUBLIC_URL;
        else process.env.FDRIVE_OFFICE_PUBLIC_URL = previousOfficePublicUrl;
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
    // This isolated fixture uses a separate editor port; production uses same-origin /onlyoffice.
    process.env.FDRIVE_OFFICE_PUBLIC_URL = officeUrl;
    environment = await startEnvironment({
      apiEntrypoint: "test/fixtures/office/e2e-server.ts",
      storage: OFFICE_STORAGE,
      indexRoot: true,
      prepareStorage: async (storage) => {
        await mkdir(storage.path("alice", `/${OFFICE_TEAM_FOLDER}`), { recursive: true });
      },
      extraApiEnv: {
        HOST: "0.0.0.0",
        FDRIVE_WORKER_TOKEN: workerToken,
        FDRIVE_FIXTURE_PUBLIC_URL: webUrl,
        FDRIVE_OFFICE_PRODUCT: product,
        FDRIVE_OFFICE_URL: officeUrl,
        FDRIVE_OFFICE_PUBLIC_URL: officeUrl,
        FDRIVE_WOPI_URL: `http://host.docker.internal:${apiPort}/wopi`,
      },
    });
    const storageRoot = environment.storageRoot;
    if (storageRoot === undefined) throw new Error("Office fixture storage root missing");
    await waitForHttpOk(`${officeUrl}/hosting/discovery`, 360_000, 1000);
    const state: OfficeFixtureState = {
      product,
      webUrl,
      apiUrl: `http://127.0.0.1:${apiPort}`,
      officeUrl,
      officeContainer: `${project}-${product}-1`,
      storageRoot,
      directory,
    };
    await writeFile(join(directory, "office.json"), JSON.stringify(state), { mode: 0o600 });
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
