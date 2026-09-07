import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * The indexer's own internal HTTP API is snake_case, matching what Python's
 * `services/indexer` actually emits (see `docs/INDEXER.md` and
 * `apps/api/src/system/indexer-client.ts`, which parses exactly this shape).
 * Timestamps use Python's `datetime.isoformat()`, which renders UTC as a
 * `+00:00` offset rather than a `Z` suffix; the fixture below deliberately
 * keeps that offset so `system.spec.ts` also exercises the real-world shape
 * that motivated `IndexerLastScan`'s `{ offset: true }` fix.
 */
const HEALTH_BODY = {
  ok: true,
  roots: ["sftpgo"],
  watcher: { sftpgo: true },
  embed_ok: true,
  schema_version: 1,
};

const STATS_BODY = {
  roots: [
    {
      root: "sftpgo",
      counts_by_status: { excluded: 3, none: 1, error: 1, indexed: 10, no_text: 1 },
      chunks: 10,
      chunks_embedded: 10,
      last_scan: {
        started_at: "2026-09-06T18:21:28.128513+00:00",
        finished_at: "2026-09-06T18:21:28.141420+00:00",
        files_seen: 16,
        files_changed: 0,
        files_deleted: 0,
        errors: 0,
      },
    },
  ],
  thumbnails: 6,
  queue_depth: 0,
  errors_sample: [
    {
      path: "alice/docs/report.pdf",
      error:
        "FileDataError: Failed to open file '/roots/sftpgo/alice/docs/report.pdf' as type pdf.",
    },
  ],
  // No rebuild has run in this static fixture; matches a real indexer that
  // has never had `POST /thumbnails/rebuild` called since it started.
  thumbnail_rebuild: {
    running: false,
    processed: 0,
    total: 0,
    started_at: null,
    finished_at: null,
    errors: 0,
  },
};

/**
 * `POST /reindex` marks matching rows pending and returns how many,
 * `{ count }` (see `docs/INDEXER.md`'s internal HTTP API table and
 * `IndexerCountRaw` in `indexer-client.ts`); the fake always reports a fixed
 * count regardless of the request body (including the `thumbnails` flag),
 * since `system.spec.ts` only asserts on the resulting toast, not on which
 * root or path was requested.
 *
 * `POST /thumbnails/rebuild` now runs the pass in the background and answers
 * `202 { started, total }` up front (see `IndexerThumbnailsRebuildResponse`);
 * the fake reports a fixed `total` the same way, regardless of `root`,
 * `path`, or `force`.
 */
const REINDEX_MARKED = 3;
const THUMBNAILS_REBUILD_TOTAL = 6;

function readBody(req: IncomingMessage): Promise<void> {
  return new Promise((resolveBody, rejectBody) => {
    req.on("data", () => {});
    req.on("end", () => resolveBody());
    req.on("error", rejectBody);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Where `GET /directory` reads from: the disposable SFTPGo container's data
 * directory, listed through `docker exec` so the answer reflects the real
 * filesystem including everything specs create during the run. Attached by
 * `global-setup.ts` once the container exists (see `attachStorage`).
 */
export interface DirectorySource {
  readonly containerId: string;
  readonly dataDir: string;
}

const MAX_DIRECTORY_ENTRIES = 10000;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

/** Mirrors the real endpoint's `directory_parts`: canonical root-relative path only. */
function directoryParts(path: string): string[] | null {
  if (
    !path.startsWith("/") ||
    path.length > 4096 ||
    path.includes("\\") ||
    CONTROL_CHARACTERS.test(path)
  ) {
    return null;
  }
  if (path === "/") {
    return [];
  }
  const parts = path.slice(1).split("/");
  return parts.some((part) => part === "" || part === "." || part === "..") ? null : parts;
}

const FIND_KINDS: Record<string, "file" | "dir" | "symlink"> = {
  f: "file",
  d: "dir",
  l: "symlink",
};

async function listContainerDirectory(
  source: DirectorySource,
  parts: readonly string[],
): Promise<{ status: number; body: unknown }> {
  const directory = [source.dataDir, ...parts].join("/");
  let stdout: string;
  try {
    const result = await execFileAsync(
      "docker",
      [
        "exec",
        source.containerId,
        "find",
        directory,
        "-mindepth",
        "1",
        "-maxdepth",
        "1",
        "-printf",
        "%y\t%f\n",
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    stdout = result.stdout;
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    if (stderr.includes("No such file")) {
      return { status: 404, body: { error: "directory unavailable" } };
    }
    if (stderr.includes("Not a directory")) {
      return { status: 400, body: { error: "directory unavailable" } };
    }
    return { status: 503, body: { error: "directory unavailable" } };
  }
  const items = stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const tab = line.indexOf("\t");
      const kind = FIND_KINDS[line.slice(0, tab)] ?? "other";
      return { name: line.slice(tab + 1), kind };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const overflow = items.length > MAX_DIRECTORY_ENTRIES;
  return { status: 200, body: { items: items.slice(0, MAX_DIRECTORY_ENTRIES), overflow } };
}

async function handleDirectory(
  url: string,
  source: DirectorySource | null,
): Promise<{ status: number; body: unknown }> {
  const query = new URL(url, "http://fake").searchParams;
  const entries = [...query.entries()];
  if (entries.length !== 2 || !query.has("root") || !query.has("path")) {
    return { status: 400, body: { error: "invalid directory query" } };
  }
  const root = query.get("root") ?? "";
  const parts = directoryParts(query.get("path") ?? "");
  if (parts === null || root.length === 0) {
    return { status: 400, body: { error: "invalid directory query" } };
  }
  if (root !== "sftpgo") {
    return { status: 404, body: { error: "unknown root" } };
  }
  if (source === null) {
    return { status: 503, body: { error: "directory unavailable" } };
  }
  return listContainerDirectory(source, parts);
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  source: () => DirectorySource | null,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = req.url ?? "/";

  if (method === "GET" && url.startsWith("/directory?")) {
    const answer = await handleDirectory(url, source());
    sendJson(res, answer.status, answer.body);
    return;
  }

  if (method === "GET" && url === "/health") {
    sendJson(res, 200, HEALTH_BODY);
    return;
  }
  if (method === "GET" && url === "/stats") {
    sendJson(res, 200, STATS_BODY);
    return;
  }
  if (method === "POST" && url === "/reindex") {
    await readBody(req);
    sendJson(res, 200, { count: REINDEX_MARKED });
    return;
  }
  if (method === "POST" && url === "/thumbnails/rebuild") {
    await readBody(req);
    sendJson(res, 202, { started: true, total: THUMBNAILS_REBUILD_TOTAL });
    return;
  }
  if (method === "POST" && url === "/extract") {
    await readBody(req);
    // Not called by any current fdrive API route (see `docs/INDEXER.md`:
    // live text preview is not wired up yet); stubbed only so a future
    // caller gets a well-formed response instead of a 404.
    sendJson(res, 200, { text: "", truncated: false });
    return;
  }

  await readBody(req);
  sendJson(res, 404, {
    error: { kind: "not_found", message: `no fake route for ${method} ${url}` },
  });
}

export interface FakeIndexer {
  readonly baseUrl: string;
  /** Points `GET /directory` at the SFTPGo container's real data directory. */
  attachStorage(source: DirectorySource): void;
  stop(): Promise<void>;
}

/**
 * Starts a minimal stand-in for `services/indexer`'s internal HTTP API on an
 * ephemeral loopback port, used by `system.spec.ts` so the Indexer and (via
 * its thumbnail-rebuild action) Thumbnails pages can exercise their
 * "configured and reachable" rendering without a real Python sidecar. Fixed
 * fixtures only: every request gets the same `GET /health` / `GET /stats`
 * body, matching the shape from the bug report this fixes (one root,
 * `sftpgo`, 10 indexed files, one extraction error).
 */
export function startFakeIndexer(): Promise<FakeIndexer> {
  return new Promise((resolveStart, rejectStart) => {
    let source: DirectorySource | null = null;
    const server: Server = createServer((req, res) => {
      handleRequest(req, res, () => source).catch((error: unknown) => {
        sendJson(res, 500, { error: { kind: "internal", message: String(error) } });
      });
    });

    server.once("error", rejectStart);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        rejectStart(new Error("fdrive e2e: fake indexer could not read back its bound port"));
        return;
      }
      resolveStart({
        baseUrl: `http://127.0.0.1:${address.port}`,
        attachStorage(next) {
          source = next;
        },
        stop: () =>
          new Promise<void>((resolveStop, rejectStop) => {
            server.close((closeError) => {
              if (closeError) {
                rejectStop(closeError);
              } else {
                resolveStop();
              }
            });
          }),
      });
    });
  });
}
