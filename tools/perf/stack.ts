/** Disposable real services. Data and embeddings are seeded, authorization is never injected. */
import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { composeApp } from "@fdrive/api/composition";
import { loadConfig } from "@fdrive/api/config";
import { FEATURES_SETTINGS_KEY, type FeatureConfiguration } from "@fdrive/contracts";
import { createDb, createRepos, migrate } from "@fdrive/db";
import { startPostgres } from "@fdrive/testkit";
import { serve } from "@hono/node-server";
import pino from "pino";
import { seedLocalUsers } from "../dev/local-users.ts";
import { createDeterministicByteStream } from "./byte-generator.js";
import { mapWithConcurrency } from "./concurrency.js";
import { extractCookiePair } from "./cookie.js";
import { createCleanup } from "./lifecycle.js";
import { command, container, ready } from "./runtime.js";
import { SEARCH_FILE_COUNT, searchDocument, TOPICS, validateVector } from "./search-fixture.js";
import { FORBIDDEN_USER, PERF_USER } from "./seed-plan.js";
import { buildStackEnv } from "./stack-env.js";
export const BIG_FILE_BYTES = 512 * 1024 * 1024;
/**
 * The ml image the stack runs, from main. Its text unit embeds the fixture and
 * every search query with `EMBED_MODEL`.
 */
export const ML_IMAGE = "ghcr.io/fredrikburmester/fdrive-ml:main";
export const EMBED_MODEL = "intfloat/multilingual-e5-small";
/**
 * Search answers only while the owner has turned it on. Hybrid search needs
 * full-text and semantic search; everything else stays off, and the
 * walkthrough counts as done so it never opens over a measured page.
 */
const SEARCH_FEATURES: FeatureConfiguration = {
  version: 1,
  revision: 1,
  values: {
    thumbnails: false,
    textSearch: true,
    searchOcr: false,
    semanticSearch: true,
    imageSearch: false,
    pdfOcr: false,
  },
  walkthroughComplete: true,
};
export interface PerfStack {
  readonly apiBaseUrl: string;
  /** Plain HTTP over the same file, the baseline the API download is measured against. */
  readonly directBaseUrl: string;
  readonly cookie: string;
  readonly forbiddenCookie: string;
  readonly embedUrl: string;
  /** `ML_IMAGE` as pulled, by digest. */
  readonly mlImage: string;
  readonly dataDir: string;
  readonly rootDir: string;
  stop(): Promise<void>;
}
export async function loginToApi(
  baseUrl: string,
  username = PERF_USER.username,
  password = PERF_USER.password,
): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-requested-with": "fdrive" },
    body: JSON.stringify({ credential: { username, password } }),
  });
  await response.body?.cancel();
  if (!response.ok) throw Error(`Fixture login failed: ${response.status}`);
  const cookie = extractCookiePair(response.headers.get("set-cookie"));
  if (!cookie) throw Error("Fixture session missing");
  return cookie;
}
/**
 * The direct download baseline: a bare Node HTTP server streaming one file
 * from disk, with no authentication, storage layer or framework, so the API
 * route is measured against the same transport.
 */
async function serveDirect(file: string, cleanup: ReturnType<typeof createCleanup>) {
  const server: Server = createServer((request, response) => {
    if (request.url !== "/big/large.bin") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": BIG_FILE_BYTES,
    });
    pipeline(createReadStream(file), response).catch(() => response.destroy());
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  cleanup.add(
    () =>
      new Promise<void>((done, reject) => {
        server.close((error) => (error ? reject(error) : done()));
        server.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
export async function startPerfStack(): Promise<PerfStack> {
  const cleanup = createCleanup();
  const rootDir = resolve(import.meta.dirname, "../..");
  try {
    const temp = await mkdtemp(join(tmpdir(), "fdrive-perf-"));
    cleanup.add(() => rm(temp, { recursive: true, force: true }));
    // The api serves this folder itself as its local storage, one home per user.
    const dataDir = join(temp, "data");
    await mkdir(dataDir);
    await chmod(dataDir, 0o755);
    const folderNames = [
      "flat-1k",
      "flat-10k",
      "search",
      "big",
      "burst",
      ...Array.from({ length: 20 }, (_, i) => `cold-${i}`),
    ];
    for (const user of [PERF_USER.username, FORBIDDEN_USER.username]) {
      await mkdir(join(dataDir, user));
    }
    for (const folder of folderNames) {
      await mkdir(join(dataDir, "perf", folder));
    }
    await mkdir(join(dataDir, "forbidden", "search"));
    console.log("[perf] seeding deterministic real filesystem fixtures");
    for (const folder of [
      "flat-1k",
      "flat-10k",
      ...folderNames.filter((n) => n.startsWith("cold-")),
    ]) {
      const count = folder === "flat-10k" ? 10000 : 1000;
      await mapWithConcurrency(
        Array.from({ length: count }, (_, i) => i),
        32,
        async (i) => {
          await writeFile(
            join(dataDir, "perf", folder, `${String(i).padStart(5, "0")}.bin`),
            Buffer.alloc(folder === "flat-10k" ? 256 : 1024, i % 251),
          );
        },
      );
    }
    await mapWithConcurrency(
      Array.from({ length: SEARCH_FILE_COUNT }, (_, i) => i),
      32,
      async (i) => {
        const doc = searchDocument(i);
        await writeFile(join(dataDir, "perf", "search", doc.name), doc.text);
      },
    );
    for (let i = 0; i < TOPICS.length; i++)
      await writeFile(
        join(dataDir, "forbidden", "search", `FORBIDDEN-${i}.txt`),
        searchDocument(i).text,
      );
    await pipeline(
      Readable.fromWeb(createDeterministicByteStream(BIG_FILE_BYTES, 4 * 1024 * 1024, 1)),
      createWriteStream(join(dataDir, "perf", "big", "large.bin")),
    );
    const directBaseUrl = await serveDirect(join(dataDir, "perf", "big", "large.bin"), cleanup);
    console.log(`[perf] starting real Postgres and the ml server's ${EMBED_MODEL} text unit`);
    const postgres = await startPostgres();
    cleanup.add(() => postgres.stop());
    const db = createDb(postgres.connectionString);
    const ended: Promise<void>[] = [];
    db.pool.on("connect", (client) => {
      ended.push(new Promise<void>((done) => client.once("end", done)));
    });
    cleanup.add(async () => {
      await db.close();
      await Promise.all(ended);
    });
    await migrate(db.db);
    const repos = createRepos(db.db);
    await seedLocalUsers(repos.localUsers, [PERF_USER, FORBIDDEN_USER]);
    await repos.settings.set(FEATURES_SETTINGS_KEY, SEARCH_FEATURES);
    await command("docker", ["pull", ML_IMAGE]);
    const mlImage = await command("docker", [
      "image",
      "inspect",
      "--format",
      "{{index .RepoDigests 0}}",
      ML_IMAGE,
    ]);
    // Only the text unit, on with no feature document. The volume keeps the
    // downloaded model (about 490 MB) for the next run.
    const mlUrl = await container(
      cleanup,
      [
        "--env",
        "FDRIVE_ML_STATIC_UNITS=text",
        "--volume",
        "fdrive-perf-ml-models:/models",
        mlImage,
      ],
      8080,
    );
    const embedUrl = `${mlUrl}/text`;
    await ready(`${embedUrl}/health`, 1200000);
    const embeddings: number[][] = [];
    for (let i = 0; i < TOPICS.length; i++) {
      const res = await fetch(`${embedUrl}/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          inputs: [`passage: ${searchDocument(i).text}`],
          normalize: true,
          truncate: true,
        }),
        signal: AbortSignal.timeout(120000),
      });
      if (!res.ok) throw Error(`Embedding the fixture failed: ${res.status}`);
      const raw: unknown = await res.json();
      if (!Array.isArray(raw)) throw Error("Fixture embedding invalid");
      embeddings.push(validateVector(raw[0]));
    }
    const root = await db.pool.query<{ id: number }>(
      "insert into idx.roots(name) values ('files') returning id",
    );
    const rootId = root.rows[0]?.id;
    if (!rootId) throw Error("Fixture root missing");
    for (let i = 0; i < TOPICS.length; i++) {
      const doc = searchDocument(i);
      const key = doc.name.split("-")[0];
      const embedding = JSON.stringify(embeddings[i]);
      await db.pool.query(
        `with inserted as (insert into idx.files(root_id,path,name,ext,size,mtime_ns,text_status,text_chars,mime) select $1,'perf/search/' || $2 || '-' || lpad(n::text,5,'0') || '.txt',$2 || '-' || lpad(n::text,5,'0') || '.txt','txt',$3::bigint,1700000000000000000,'ok',$3::int,'text/plain' from generate_series($4::int,24999,32) n returning id) insert into idx.chunks(file_id,idx,text,embedding) select id,0,$5,$6::vector from inserted`,
        [rootId, key, Buffer.byteLength(doc.text), i, doc.text, embedding],
      );
      await db.pool.query(
        `with inserted as (insert into idx.files(root_id,path,name,ext,size,mtime_ns,text_status,text_chars,mime) values ($1,$2,$3,'txt',$4::bigint,1700000000000000000,'ok',$4::int,'text/plain') returning id) insert into idx.chunks(file_id,idx,text,embedding) select id,0,$5,$6::vector from inserted`,
        [
          rootId,
          `forbidden/search/FORBIDDEN-${i}.txt`,
          `FORBIDDEN-${i}.txt`,
          Buffer.byteLength(doc.text),
          doc.text,
          embedding,
        ],
      );
    }
    await db.pool.query("ANALYZE idx.files; ANALYZE idx.chunks");
    const config = loadConfig({
      ...buildStackEnv({
        databaseUrl: postgres.connectionString,
        storageRoot: dataDir,
        masterKeyBase64: randomBytes(32).toString("base64"),
      }),
      FDRIVE_INDEX_ROOTS: JSON.stringify([
        { name: "files", storagePath: dataDir, indexerPath: "/data" },
      ]),
      FDRIVE_EMBED_URL: embedUrl,
      // The settings layout check opens admin-only System pages; admin status gates
      // nothing on the measured listing, search, download and upload paths.
      FDRIVE_ADMIN_USERS: PERF_USER.username,
    });
    const composed = await composeApp(config, pino({ level: "silent" }));
    cleanup.add(() => composed.close());
    const { server, port } = await new Promise<{ server: ReturnType<typeof serve>; port: number }>(
      (resolve) => {
        const server = serve(
          { fetch: composed.app.fetch, port: 0, hostname: "127.0.0.1" },
          (info) => resolve({ server, port: info.port }),
        );
      },
    );
    cleanup.add(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          if ("closeAllConnections" in server) server.closeAllConnections();
        }),
    );
    const apiBaseUrl = `http://127.0.0.1:${port}`;
    const cookie = await loginToApi(apiBaseUrl);
    const forbiddenCookie = await loginToApi(
      apiBaseUrl,
      FORBIDDEN_USER.username,
      FORBIDDEN_USER.password,
    );
    return {
      apiBaseUrl,
      directBaseUrl,
      cookie,
      forbiddenCookie,
      embedUrl,
      mlImage,
      dataDir,
      rootDir,
      stop: () => cleanup.close(),
    };
  } catch (error) {
    try {
      await cleanup.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Fixture startup and cleanup failed");
    }
    throw error;
  }
}
