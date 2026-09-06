import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

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
};

/**
 * `POST /reindex` and `POST /thumbnails/rebuild` both mark matching rows
 * pending and return how many, `{ count }` (see `docs/INDEXER.md`'s internal
 * HTTP API table and `IndexerCountRaw` in `indexer-client.ts`); the fake
 * always reports fixed counts regardless of the request body, since
 * `system.spec.ts` only asserts on the resulting toast, not on which root or
 * path was requested.
 */
const REINDEX_MARKED = 3;
const THUMBNAILS_REBUILD_MARKED = 6;

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

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const url = req.url ?? "/";

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
    sendJson(res, 200, { count: THUMBNAILS_REBUILD_MARKED });
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
    const server: Server = createServer((req, res) => {
      handleRequest(req, res).catch((error: unknown) => {
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
