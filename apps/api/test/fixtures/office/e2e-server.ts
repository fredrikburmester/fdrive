/** Dedicated disposable-browser fixture process. Never imported by production. */
import { PUBLIC_URL_SETTINGS_KEY } from "@fdrive/contracts";
import { createDb, createRepos, migrate } from "@fdrive/db";
import pino from "pino";
import { composeApp } from "../../../src/composition.ts";
import { loadConfig } from "../../../src/config.ts";
import { OFFICE_SETTINGS_KEY } from "../../../src/office/settings.ts";
import { startServer } from "../../../src/server.ts";

const config = loadConfig(process.env);
if (!config.fdriveStorageRoot) throw new Error("Fixture storage root missing");
const { db, pool } = createDb(config.databaseUrl);
try {
  await migrate(db);
  const repos = createRepos(db);
  await repos.settings.set("features.configuration", {
    version: 1,
    revision: 1,
    values: {
      thumbnails: false,
      textSearch: false,
      searchOcr: false,
      semanticSearch: false,
      imageSearch: false,
      pdfOcr: false,
    },
    walkthroughComplete: true,
  });
  // The address the browser opens the fixture at; production owners choose
  // it in onboarding, this process is told by `office-e2e/setup.ts`.
  await repos.settings.set(PUBLIC_URL_SETTINGS_KEY, {
    revision: 1,
    url: new URL(process.env.FDRIVE_FIXTURE_PUBLIC_URL ?? "http://127.0.0.1:3000").origin,
  });
  await repos.settings.set(OFFICE_SETTINGS_KEY, {
    revision: 1,
    enabled: true,
    editingEnabled: true,
    editorUsernames: ["alice", "bob"],
  });
} finally {
  await pool.end();
}
const logger = pino({ level: "warn" });
const composed = await composeApp(config, logger, () => new Date());
const server = startServer(composed.app, config, logger);
let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    await server.close();
  } finally {
    await composed.close();
  }
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
