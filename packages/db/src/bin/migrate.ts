#!/usr/bin/env node
import { createDb, migrate, parseDatabaseUrl } from "../index.js";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is not set");
  }

  const parsed = parseDatabaseUrl(databaseUrl);
  if (!parsed.ok) {
    throw new Error(`DATABASE_URL is invalid: ${parsed.reason}`);
  }

  const { db, close } = createDb(parsed.value);
  try {
    await migrate(db);
  } finally {
    await close();
  }
}

main()
  .then(() => {
    console.log("migrations applied");
  })
  .catch((error: unknown) => {
    console.error("migration failed:", error);
    process.exitCode = 1;
  });
