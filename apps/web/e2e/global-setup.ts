import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SEED_FILES } from "@fdrive/testkit";
import { Client } from "pg";
import { ACCOUNT_FILES } from "./support/account-fixture.js";
import { startEnvironment } from "./support/environment.js";
import { startFakeIndexer } from "./support/fake-indexer.js";
import { E2E_HOST, writeStateDirPointer } from "./support/paths.js";
import { resolvePort } from "./support/ports.js";
import { registry } from "./support/registry.js";

/**
 * Matches `FDRIVE_HOME_TEMPLATE`'s default (`sftpgo:/{username}`): the one
 * index root every seeded identity's home lives under.
 */
const INDEX_ROOT_NAME = "sftpgo";

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/** The extension (with leading dot), matching `@fdrive/core`'s `extensionOf` for a plain name. */
function extensionOf(name: string): string {
  const dotIndex = name.lastIndexOf(".");
  return dotIndex > 0 ? name.slice(dotIndex).toLowerCase() : "";
}

/**
 * Seeds `idx.roots`, `idx.files` for every one of alice's testkit-seeded
 * files, and an `idx.chunks` row (no embedding) for the readme's text, so
 * `search.spec.ts` has real rows to find: a filename match on "readme.md",
 * a content match on a word from the readme, and (since only alice's files
 * are indexed under alice's scope) proof that bob's search for the same
 * term finds nothing.
 *
 * Runs after the API is healthy, since the API applies the `idx`/`app`
 * schema migrations on boot (`FDRIVE_AUTO_MIGRATE=true`) and this needs
 * those tables to already exist.
 */
async function seedSearchIndex(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const rootResult = await client.query<{ id: number }>(
      `insert into idx.roots (name) values ($1)
       on conflict (name) do update set name = excluded.name
       returning id`,
      [INDEX_ROOT_NAME],
    );
    const rootId = rootResult.rows[0]?.id;
    if (rootId === undefined) {
      throw new Error("fdrive e2e: failed to seed idx.roots");
    }

    const indexedFiles = { alice: SEED_FILES.alice ?? {}, ...ACCOUNT_FILES };
    const mtimeNs = (BigInt(Date.now()) * BigInt(1_000_000)).toString();
    let readmeFileId: number | undefined;
    let readmeText: string | undefined;

    for (const [username, files] of Object.entries(indexedFiles)) {
      for (const [virtualPath, content] of Object.entries(files)) {
        // testkit's SEED_FILES paths are alice-home-relative ("/docs/readme.md");
        // the index stores root-relative paths with no leading slash
        // ("alice/docs/readme.md"), matching the indexer's own convention.
        const relativePath = `${username}${virtualPath}`;
        const name = virtualPath.split("/").at(-1) ?? virtualPath;
        const ext = extensionOf(name);
        const size = Buffer.byteLength(content, "utf-8");
        const sha256 = sha256Hex(content);

        const fileResult = await client.query<{ id: number }>(
          `insert into idx.files (root_id, path, name, ext, size, mtime_ns, sha256, text_status)
         values ($1, $2, $3, $4, $5, $6, $7, 'done')
         on conflict (root_id, path)
         do update set sha256 = excluded.sha256, size = excluded.size, name = excluded.name
         returning id`,
          [rootId, relativePath, name, ext, size, mtimeNs, sha256],
        );
        const fileId = fileResult.rows[0]?.id;
        if (relativePath === "alice/docs/readme.md") {
          readmeFileId = fileId;
          readmeText = content;
        }
      }
    }

    if (readmeFileId !== undefined && readmeText !== undefined) {
      await client.query(`delete from idx.chunks where file_id = $1`, [readmeFileId]);
      await client.query(`insert into idx.chunks (file_id, idx, text) values ($1, 0, $2)`, [
        readmeFileId,
        readmeText,
      ]);
    }
  } finally {
    await client.end();
  }
}

/**
 * Resolves this run's ports and state directory and exports them onto
 * `process.env`, so two suites started at once on one machine (two agents,
 * or a developer next to a CI-like run) never collide: `E2E_API_PORT` and
 * `E2E_WEB_PORT` win when set, otherwise a free port is bound on the fly
 * (see `support/ports.ts`); the state directory is always a fresh
 * `fs.mkdtemp` directory, named after the resolved ports so two runs never
 * share one even by coincidence.
 *
 * Playwright runs `globalSetup` in the same process that resolved
 * `playwright.config.ts`, and forks every worker process from that same
 * process afterwards with its current `process.env` (Playwright reloads the
 * config fresh in each worker, so a worker's own `baseURL` and
 * `storageState` correctly reflect the values set here, not whatever
 * `support/paths.ts` saw before this function ran). `E2E_STATE_DIR` is set
 * on `process.env` for that normal, same-machine-fork case, and mirrored
 * into a pointer file keyed by this process's pid (see
 * `support/paths.ts#getStateDirectory`) as a fallback for any process that,
 * for whatever reason, does not inherit it.
 */
async function resolveRunEnvironment(): Promise<{
  apiPort: number;
  webPort: number;
  stateDir: string;
}> {
  const apiPort = await resolvePort("E2E_API_PORT", E2E_HOST);
  const webPort = await resolvePort("E2E_WEB_PORT", E2E_HOST);
  process.env.E2E_API_PORT = String(apiPort);
  process.env.E2E_WEB_PORT = String(webPort);

  const stateDir = await mkdtemp(join(tmpdir(), `fdrive-e2e-${apiPort}-${webPort}-`));
  process.env.E2E_STATE_DIR = stateDir;
  writeStateDirPointer(process.pid, stateDir);

  return { apiPort, webPort, stateDir };
}

/**
 * Playwright's global setup: resolves this run's ports and state directory
 * (see `resolveRunEnvironment` above) so concurrent suites never collide;
 * starts the fake indexer sidecar `system.spec.ts` exercises; boots
 * Postgres, SFTPGo, the API (with `FDRIVE_INDEX_ROOTS` set so search is
 * available and `FDRIVE_INDEXER_URL` pointed at the fake indexer), and the
 * web app once for the whole run (see `support/environment.ts`); seeds the
 * search index for `search.spec.ts`; and stashes the environment handle for
 * `global-teardown.ts`. Never used to seed *file* data through the UI or
 * SFTPGo directly; each spec creates the folders and files it needs under
 * unique names, so tests stay independent of each other. The search index
 * rows are the one exception, since they must exist before any spec runs and
 * are keyed to the fixed, shared testkit seed data rather than anything a
 * spec creates itself.
 */
export default async function globalSetup(): Promise<void> {
  await resolveRunEnvironment();

  const indexRoots = JSON.stringify([
    { name: INDEX_ROOT_NAME, sftpgoPath: "/srv/sftpgo/data", indexerPath: "/roots/sftpgo" },
  ]);

  const fakeIndexer = await startFakeIndexer();

  const environment = await startEnvironment({
    extraApiEnv: { FDRIVE_INDEX_ROOTS: indexRoots, FDRIVE_INDEXER_URL: fakeIndexer.baseUrl },
    extraStopFns: [() => fakeIndexer.stop()],
  });
  registry.current = environment;

  await seedSearchIndex(environment.databaseUrl);
}
