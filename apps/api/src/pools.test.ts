import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  API_POOLS,
  CONNECTION_BUDGET,
  CONNECTION_WAIT_MS,
  openApiPools,
  POSTGRES_MAX_CONNECTIONS,
  POSTGRES_RESERVED_CONNECTIONS,
} from "./pools.ts";

const repo = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

/** The number a constant is set to in another service's source. */
function constant(path: string, name: string): number {
  const found = new RegExp(`\\b${name}\\b[^=\\n]*=\\s*(\\d+)`).exec(repo(path));
  if (!found) throw new Error(`${name} not found in ${path}`);
  return Number(found[1]);
}

describe("the API's pools", () => {
  it("open each pool at its size, named, and wait for a connection only as long as allowed", async () => {
    const pools = openApiPools("postgres://fdrive@127.0.0.1:1/fdrive", () => undefined);
    try {
      for (const [name, size] of Object.entries(API_POOLS)) {
        const { options } = pools[name as keyof typeof API_POOLS].pool as unknown as {
          options: { max: number; application_name: string; connectionTimeoutMillis?: number };
        };
        expect(options).toMatchObject({ max: size, application_name: `fdrive api ${name}` });
        // A write waits for the gate as long as the writes before it take.
        expect(options.connectionTimeoutMillis).toBe(
          name === "writeGate" ? undefined : CONNECTION_WAIT_MS,
        );
      }
    } finally {
      await pools.close();
    }
  });

  it("say which pool an idle connection's error came from", async () => {
    const onError = vi.fn();
    const pools = openApiPools("postgres://fdrive@127.0.0.1:1/fdrive", onError);
    const error = new Error("terminated");
    pools.office.pool.emit("error", error);
    expect(onError).toHaveBeenCalledWith("office", error);
    await pools.close();
  });
});

describe("the connection budget", () => {
  it("fits every fdrive process in what the deployment's Postgres allows", () => {
    const total = Object.values(CONNECTION_BUDGET).reduce((sum, count) => sum + count, 0);
    expect(total).toBeLessThanOrEqual(POSTGRES_MAX_CONNECTIONS - POSTGRES_RESERVED_CONNECTIONS);
    expect(repo("deploy/compose.yaml")).toContain(`max_connections=${POSTGRES_MAX_CONNECTIONS}`);
    // The budget's one table, and the operator's pointer to it, say the same.
    expect(repo("docs/ARCHITECTURE.md")).toContain(
      `| **Total** | of ${POSTGRES_MAX_CONNECTIONS}, ${POSTGRES_RESERVED_CONNECTIONS} kept for superusers | **${total}** |`,
    );
    expect(repo("deploy/REFERENCE.md")).toContain(`open at most ${total} together`);
  });

  it("counts the indexer's and OCR's connections as their code bounds them", () => {
    const workers = constant("services/indexer/src/settings.rs", "MAX_WORKERS");
    const http = constant("services/indexer/src/main.rs", "HTTP_BLOCKING_THREADS");
    expect(CONNECTION_BUDGET.indexer).toBe(3 * workers + 10 + http);
    const originals = constant("services/ocr/src/fdrive_ocr/server.py", "ORIGINALS_AT_ONCE");
    expect(CONNECTION_BUDGET.ocr).toBe(3 + originals);
    expect(repo("packages/contracts/src/system.ts")).toContain(
      `workers: z.number().int().min(1).max(${workers})`,
    );
  });

  it("counts the API's pools and its LISTEN connection", () => {
    expect(CONNECTION_BUDGET.api).toBe(
      API_POOLS.writeGate + API_POOLS.office + API_POOLS.fileOperations + API_POOLS.main + 1,
    );
  });
});
