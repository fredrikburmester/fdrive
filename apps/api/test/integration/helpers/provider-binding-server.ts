import { createFakeSftpgoServer, createSftpgoClient } from "@fdrive/sftpgo";
import { serve } from "@hono/node-server";

export const USERNAME = "shared-user";
export const SHARED_PATH = "/same.txt";

/** Only counts leave the fixture. Authorization values never enter assertion output. */
export interface ProviderCalls {
  requests: number;
  passwords: number;
  bearers: number;
  mutations: number;
  foreignCredentials: number;
}

function deferred<T>() {
  let resolve = (_value: T) => {};
  let reject = (_error: unknown) => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function createBarrier() {
  const entered = deferred<void>();
  const released = deferred<void>();
  return {
    async wait() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          entered.promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("provider barrier was not reached")), 5000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    async block() {
      entered.resolve();
      await released.promise;
    },
    release: () => released.resolve(),
  };
}

/** SFTPGo protocol fixture served over real TCP, with distinct credentials and content per host. */
export async function startProviderServer(label: "A" | "B", clock: () => Date) {
  const password = `fixture-${label}-password`;
  const fake = createFakeSftpgoServer({
    users: [{ username: USERNAME, password, permissions: { "/": ["*"] } }],
    files: { [USERNAME]: { [SHARED_PATH]: `content from ${label}` } },
    now: clock,
  });
  const ownBasic = `Basic ${Buffer.from(`${USERNAME}:${password}`).toString("base64")}`;
  const calls: ProviderCalls = {
    requests: 0,
    passwords: 0,
    bearers: 0,
    mutations: 0,
    foreignCredentials: 0,
  };
  type Gate = ReturnType<typeof createBarrier> & {
    method: string;
    pathname: string;
    unauthorized: boolean;
  };
  const gates: Gate[] = [];
  const active = new Set<Gate>();
  const listening = deferred<number>();
  const server = serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        calls.requests++;
        const authorization = request.headers.get("authorization");
        if (authorization?.startsWith("Basic ")) {
          calls.passwords++;
          if (authorization !== ownBasic) calls.foreignCredentials++;
        } else if (authorization?.startsWith("Bearer ")) {
          calls.bearers++;
          if (!fake.state.tokens.has(authorization.slice(7))) calls.foreignCredentials++;
        }
        if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) calls.mutations++;
        const index = gates.findIndex(
          (gate) => gate.method === request.method && gate.pathname === pathname,
        );
        const gate = index < 0 ? undefined : gates.splice(index, 1)[0];
        if (gate !== undefined) {
          active.add(gate);
          await gate.block();
          active.delete(gate);
          if (gate.unauthorized)
            return Response.json({ message: "fixture token expired" }, { status: 401 });
        }
        if (pathname === "/healthz") return new Response("ok");
        return fake.fetch(request);
      },
    },
    (info) => listening.resolve(info.port),
  );
  server.once("error", listening.reject);
  const baseUrl = `http://127.0.0.1:${await listening.promise}`;
  return {
    baseUrl,
    password,
    client: createSftpgoClient({ baseUrl, fetch: globalThis.fetch }),
    counts: () => ({ ...calls }),
    pause(method: string, pathname: string, unauthorized = false) {
      const gate = { ...createBarrier(), method, pathname, unauthorized };
      gates.push(gate);
      return gate;
    },
    async close() {
      for (const gate of [...gates, ...active]) gate.release();
      if ("closeAllConnections" in server) server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
