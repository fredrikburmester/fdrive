/** Disposable real services. Data and embeddings are seeded, authorization is never injected. */
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { composeApp } from "@fdrive/api/composition";
import { loadConfig } from "@fdrive/api/config";
import { createDb, migrate } from "@fdrive/db";
import { createSftpgoClient } from "@fdrive/sftpgo";
import { buildSftpgoDump, startPostgres } from "@fdrive/testkit";
import { serve } from "@hono/node-server";
import pino from "pino";
import { createDeterministicByteStream } from "./byte-generator.js";
import { mapWithConcurrency } from "./concurrency.js";
import { extractCookiePair } from "./cookie.js";
import { createCleanup } from "./lifecycle.js";
import { command, container, ready } from "./runtime.js";
import { SEARCH_FILE_COUNT, searchDocument, TOPICS, validateVector } from "./search-fixture.js";
import { PERF_USER } from "./seed-plan.js";
import { buildStackEnv } from "./stack-env.js";
export const BIG_FILE_BYTES = 512 * 1024 * 1024;
export interface PerfStack {
  readonly apiBaseUrl: string;
  readonly sftpgoBaseUrl: string;
  readonly cookie: string;
  readonly sftpgoToken: string;
  readonly forbiddenCookie: string;
  readonly embedUrl: string;
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
    body: JSON.stringify({ username, password }),
  });
  await response.body?.cancel();
  if (!response.ok) throw Error(`Fixture login failed: ${response.status}`);
  const cookie = extractCookiePair(response.headers.get("set-cookie"));
  if (!cookie) throw Error("Fixture session missing");
  return cookie;
}
export async function startPerfStack(): Promise<PerfStack> {
  const cleanup = createCleanup();
  const rootDir = resolve(import.meta.dirname, "../..");
  try {
    const temp = await mkdtemp(join(tmpdir(), "fdrive-perf-"));
    cleanup.add(() => rm(temp, { recursive: true, force: true }));
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
    for (const user of ["perf", "forbidden"]) {
      await mkdir(join(dataDir, user), { mode: 0o777 });
      await chmod(join(dataDir, user), 0o777);
    }
    for (const folder of folderNames) {
      await mkdir(join(dataDir, "perf", folder), { mode: 0o777 });
      await chmod(join(dataDir, "perf", folder), 0o777);
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
    const dump = buildSftpgoDump(
      [
        PERF_USER,
        { username: "forbidden", password: "forbidden-perf-password", permissions: { "/": ["*"] } },
      ],
      [],
      { dataDir: "/srv/sftpgo/data" },
    );
    const dumpPath = join(temp, "seed.json");
    await writeFile(dumpPath, JSON.stringify(dump));
    console.log("[perf] starting real SFTPGo, Postgres and multilingual-e5-small TEI CPU");
    const dataVolume = `fdrive-perf-${process.pid}-${randomBytes(8).toString("hex")}`;
    await command("docker", ["volume", "create", dataVolume]);
    cleanup.add(async () => {
      await command("docker", ["volume", "rm", dataVolume]);
    });
    let sftpgoContainerId = "";
    const sftpgoBaseUrl = await container(
      cleanup,
      [
        "--mount",
        `type=volume,source=${dataVolume},target=/srv/sftpgo/data`,
        "--mount",
        `type=bind,source=${dumpPath},target=/tmp/seed.json,readonly`,
        "--env",
        "SFTPGO_LOADDATA_FROM=/tmp/seed.json",
        "drakkan/sftpgo:v2.7.5",
      ],
      8080,
      command,
      async (id) => {
        sftpgoContainerId = id;
        await command("docker", ["cp", `${dataDir}/.`, `${id}:/srv/sftpgo/data`]);
      },
    );
    await ready(`${sftpgoBaseUrl}/healthz`);
    const volumeModes = await command("docker", [
      "exec",
      sftpgoContainerId,
      "stat",
      "-c",
      "%a:%u:%g",
      "/srv/sftpgo/data/perf",
      "/srv/sftpgo/data/perf/burst",
      "/srv/sftpgo/data/perf/flat-10k/00000.bin",
    ]);
    if (
      volumeModes
        .split("\n")
        .map((line) => line.split(":")[0])
        .join(",") !== "777,777,644"
    )
      throw Error("Fixture volume permissions differ");
    console.log(`[perf] volume directory/file mode:uid:gid ${volumeModes.replaceAll("\n", " ")}`);
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
    const embedUrl = await container(
      cleanup,
      [
        "--platform",
        "linux/amd64",
        "--volume",
        "fdrive-perf-models:/data",
        "ghcr.io/huggingface/text-embeddings-inference:cpu-latest",
        "--model-id",
        "intfloat/multilingual-e5-small",
      ],
      80,
    );
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
      if (!res.ok) throw Error(`TEI seed failed: ${res.status}`);
      const raw: unknown = await res.json();
      if (!Array.isArray(raw)) throw Error("TEI seed invalid");
      embeddings.push(validateVector(raw[0]));
    }
    const root = await db.pool.query<{ id: number }>(
      "insert into idx.roots(name) values ('sftpgo') returning id",
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
    const image = `fdrive-perf-indexer:${process.pid}`;
    await command("docker", ["build", "--tag", image, join(rootDir, "services/indexer")]);
    cleanup.add(async () => {
      await command("docker", ["image", "rm", image]);
    });
    const pgUrl = new URL(postgres.connectionString);
    pgUrl.hostname = "host.docker.internal";
    const indexerUrl = await container(
      cleanup,
      [
        "--mount",
        `type=volume,source=${dataVolume},target=/roots/sftpgo,readonly`,
        "--mount",
        `type=bind,source=${join(rootDir, "tools/perf/directory_server.py")},target=/fixture.py,readonly`,
        "--env",
        `DATABASE_URL=${pgUrl}`,
        "--env",
        "INDEX_ROOTS=sftpgo=/roots/sftpgo",
        "--env",
        `EMBED_URL=${embedUrl.replace("127.0.0.1", "host.docker.internal")}`,
        "--entrypoint",
        "python",
        image,
        "/fixture.py",
      ],
      8010,
    );
    await ready(`${indexerUrl}/directory?root=sftpgo&path=/perf`);
    const sftpgoClient = createSftpgoClient({ baseUrl: sftpgoBaseUrl });
    const token = await sftpgoClient.login(PERF_USER);
    const config = loadConfig({
      ...buildStackEnv({
        databaseUrl: postgres.connectionString,
        sftpgoUrl: sftpgoBaseUrl,
        masterKeyBase64: randomBytes(32).toString("base64"),
      }),
      FDRIVE_HOME_TEMPLATE: "sftpgo:/{username}",
      FDRIVE_INDEX_ROOTS: JSON.stringify([
        { name: "sftpgo", sftpgoPath: "/srv/sftpgo/data", indexerPath: "/roots/sftpgo" },
      ]),
      FDRIVE_EMBED_URL: embedUrl,
      FDRIVE_INDEXER_URL: indexerUrl,
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
    const forbiddenCookie = await loginToApi(apiBaseUrl, "forbidden", "forbidden-perf-password");
    return {
      apiBaseUrl,
      sftpgoBaseUrl,
      cookie,
      forbiddenCookie,
      sftpgoToken: token.accessToken,
      embedUrl,
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
