import net from "node:net";
import { afterAll, beforeAll, describe, it } from "vitest";
import type { PostgresContainer } from "../../src/containers/postgres.js";
import { startPostgres } from "../../src/containers/postgres.js";

async function assertTcpReachable(host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host, port }, () => {
      socket.end();
      resolve();
    });
    socket.on("error", reject);
  });
}

describe("testkit containers", () => {
  let postgres: PostgresContainer;

  beforeAll(async () => {
    postgres = await startPostgres();
  }, 180_000);

  afterAll(async () => {
    await postgres?.stop();
  }, 180_000);

  it("postgres container accepts TCP connections", async () => {
    const url = new URL(postgres.connectionString);
    await assertTcpReachable(url.hostname, Number(url.port));
  });
});
