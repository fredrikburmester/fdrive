/** Dedicated disposable-browser fixture process. Never imported by production. */
import { createDb, createRepos, migrate } from "@fdrive/db";
import pino from "pino";
import { composeApp } from "../../../src/composition.ts";
import { loadConfig } from "../../../src/config.ts";
import { startServer } from "../../../src/server.ts";
import { fixtureOfficeAuthorizer } from "./seeded-permissions.ts";

const config = loadConfig(process.env);
if (!config.sftpgoUrl) throw new Error("Fixture storage URL missing");
const { db, pool } = createDb(config.databaseUrl);
let providerId: string;
try {
  await migrate(db);
  const provider = await createRepos(db).providers.ensure({
    type: "sftpgo",
    baseUrl: config.sftpgoUrl,
  });
  providerId = provider.id;
} finally {
  await pool.end();
}
const logger = pino({ level: "warn" });
const composed = await composeApp(config, logger, () => new Date(), {
  officeCanEdit: fixtureOfficeAuthorizer(providerId),
});
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
