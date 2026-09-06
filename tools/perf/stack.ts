/**
 * Boots the real stack the perf harness measures against: a Postgres and an
 * SFTPGo testcontainer (via `@fdrive/testkit`, the same containers the
 * integration tests use), seeded with the perf fixtures over SFTPGo's own
 * REST API, plus the fdrive API itself running in-process via
 * `composeApp`. Nothing here is a pure function (it is all I/O against
 * Docker, Postgres, and SFTPGo), so it is exercised by actually running
 * `pnpm perf` rather than by a unit test; the pure pieces it is built from
 * (`buildStackEnv`, `buildFlatSeedPlan`, `fillPseudoRandomBytes`,
 * `mapWithConcurrency`, `extractCookiePair`) each have their own tests.
 */
import { randomBytes } from "node:crypto";
import { composeApp } from "@fdrive/api/composition";
import { loadConfig } from "@fdrive/api/config";
import { ROUTES } from "@fdrive/contracts";
import { createSftpgoClient, type SftpgoUserApi } from "@fdrive/sftpgo";
import { SEED_USERS, startPostgres, startSftpgo } from "@fdrive/testkit";
import { serve } from "@hono/node-server";
import pino from "pino";
import { createDeterministicByteStream, fillPseudoRandomBytes } from "./byte-generator.js";
import { mapWithConcurrency } from "./concurrency.js";
import { extractCookiePair } from "./cookie.js";
import { buildFlatSeedPlan, PERF_USER } from "./seed-plan.js";
import { buildStackEnv } from "./stack-env.js";

/** Header the API's CSRF guard requires on every state-changing request (see apps/api/src/auth/principal.ts). */
const REQUESTED_WITH_HEADER = { "x-requested-with": "fdrive" } as const;

export const FLAT_1K_COUNT = 1000;
export const FLAT_1K_FILE_BYTES = 1024;
export const FLAT_10K_COUNT = 10_000;
export const FLAT_10K_FILE_BYTES = 256;
export const SEED_CONCURRENCY = 16;
export const BIG_FILE_BYTES = 512 * 1024 * 1024;
const BIG_FILE_CHUNK_BYTES = 4 * 1024 * 1024;
const BIG_FILE_SEED = 1;

export interface PerfStack {
  readonly apiBaseUrl: string;
  readonly sftpgoBaseUrl: string;
  readonly cookie: string;
  readonly sftpgoToken: string;
  stop(): Promise<void>;
}

/** Uploads `plan`'s files to SFTPGo with bounded concurrency, each filled with deterministic bytes. */
async function seedFlatDirectory(
  userApi: SftpgoUserApi,
  plan: readonly { path: string; sizeBytes: number }[],
  concurrency: number,
): Promise<void> {
  await mapWithConcurrency(plan, concurrency, async (file, index) => {
    const { bytes } = fillPseudoRandomBytes(file.sizeBytes, index + 1);
    await userApi.upload(file.path, bytes, { mkdirParents: true });
  });
}

/** Streams `BIG_FILE_BYTES` of deterministic pseudo random data to `/big/large.bin` without buffering it all in memory. */
async function seedBigFile(userApi: SftpgoUserApi): Promise<void> {
  await userApi.upload(
    "/big/large.bin",
    createDeterministicByteStream(BIG_FILE_BYTES, BIG_FILE_CHUNK_BYTES, BIG_FILE_SEED),
    { mkdirParents: true, contentLength: BIG_FILE_BYTES },
  );
}

/** Logs in as `perf` through the fdrive API's own `/auth/login` and returns its session cookie. */
async function loginToApi(apiBaseUrl: string): Promise<string> {
  const response = await fetch(`${apiBaseUrl}${ROUTES.auth.login}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...REQUESTED_WITH_HEADER },
    body: JSON.stringify({ username: PERF_USER.username, password: PERF_USER.password }),
  });
  await response.arrayBuffer();
  if (!response.ok) {
    throw new Error(
      `perf stack: login as "${PERF_USER.username}" against the fdrive API failed with status ${response.status}`,
    );
  }
  const cookie = extractCookiePair(response.headers.get("set-cookie"));
  if (cookie === undefined) {
    throw new Error("perf stack: login response did not set a session cookie");
  }
  return cookie;
}

/**
 * Starts Postgres and SFTPGo testcontainers, seeds SFTPGo's `perf` user with
 * `/flat-1k` (1,000 x 1 KiB files), `/flat-10k` (10,000 x 256 byte files),
 * and `/big/large.bin` (512 MiB), starts the fdrive API in-process on an
 * ephemeral port, and logs in as `perf`. Returns everything a scenario
 * needs plus a `stop()` that tears down the API, containers, and pool.
 */
export async function startPerfStack(): Promise<PerfStack> {
  console.log("[perf] starting Postgres container...");
  const postgres = await startPostgres();

  console.log("[perf] starting SFTPGo container...");
  const sftpgo = await startSftpgo({ users: [...SEED_USERS, PERF_USER] });

  console.log(
    "[perf] seeding SFTPGo fixtures over its REST API (1,000 + 10,000 files, then a 512 MiB file; this takes a few minutes)...",
  );
  const sftpgoClient = createSftpgoClient({ baseUrl: sftpgo.baseUrl });
  const token = await sftpgoClient.login({
    username: PERF_USER.username,
    password: PERF_USER.password,
  });
  const userApi = sftpgoClient.user(token.accessToken);

  await seedFlatDirectory(
    userApi,
    buildFlatSeedPlan("/flat-1k", FLAT_1K_COUNT, FLAT_1K_FILE_BYTES),
    SEED_CONCURRENCY,
  );
  console.log("[perf] seeded /flat-1k");

  await seedFlatDirectory(
    userApi,
    buildFlatSeedPlan("/flat-10k", FLAT_10K_COUNT, FLAT_10K_FILE_BYTES),
    SEED_CONCURRENCY,
  );
  console.log("[perf] seeded /flat-10k");

  await seedBigFile(userApi);
  console.log("[perf] seeded /big/large.bin");

  console.log("[perf] starting the fdrive API in-process...");
  const masterKey = randomBytes(32).toString("base64");
  const config = loadConfig(
    buildStackEnv({
      databaseUrl: postgres.connectionString,
      sftpgoUrl: sftpgo.baseUrl,
      masterKeyBase64: masterKey,
    }),
  );
  const logger = pino({ level: config.logLevel });
  const composed = await composeApp(config, logger);

  const { server, port } = await new Promise<{
    server: ReturnType<typeof serve>;
    port: number;
  }>((resolve) => {
    const started = serve({ fetch: composed.app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
      resolve({ server: started, port: info.port });
    });
  });

  const apiBaseUrl = `http://127.0.0.1:${port}`;
  const cookie = await loginToApi(apiBaseUrl);
  console.log(`[perf] fdrive API listening at ${apiBaseUrl}`);

  return {
    apiBaseUrl,
    sftpgoBaseUrl: sftpgo.baseUrl,
    cookie,
    sftpgoToken: token.accessToken,
    async stop(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await composed.close();
      await sftpgo.stop();
      await postgres.stop();
    },
  };
}
