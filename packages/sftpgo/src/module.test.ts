import { isStorageError, type StorageSession } from "@fdrive/core";
import { describe, expect, it, vi } from "vitest";
import { createSftpgoClient } from "./client.js";
import { createFakeSftpgoServer } from "./fake/server.js";
import { sftpgoHomeTemplate, sftpgoModule } from "./module.js";

const INSTANCE = { id: "p1", baseUrl: "http://sftpgo.test", config: {} };

function server() {
  return createFakeSftpgoServer({
    users: [{ username: "alice", password: "secret", permissions: { "/": ["*"] } }],
    files: { alice: { "/hello.txt": "hello" } },
  });
}

async function kindOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return isStorageError(error) ? error.kind : "other";
  }
}

describe("sftpgoModule", () => {
  it("declares its type, fields, capabilities and attribution", () => {
    expect(sftpgoModule.type).toBe("sftpgo");
    expect(sftpgoModule.trash).toBe("native");
    expect(sftpgoModule.attribution?.name).toBe("SFTPGo");
    expect(sftpgoModule.credentialFields.map((field) => field.name)).toEqual([
      "username",
      "password",
      "otp",
    ]);
    expect(sftpgoModule.credentialFields.find((field) => field.name === "otp")?.transient).toBe(
      true,
    );
    expect(sftpgoModule.capabilities).toMatchObject({ zip: true, shares: true, index: true });
  });

  it("requires an explicit home template for index mapping", () => {
    expect(sftpgoHomeTemplate({ config: {} })).toBeNull();
    expect(sftpgoHomeTemplate({ config: { homeTemplate: "" } })).toBeNull();
    expect(sftpgoHomeTemplate({ config: { homeTemplate: "x:/{username}" } })).toBe("x:/{username}");
  });

  it("probes the server", async () => {
    const probeFetch: typeof fetch = async (url) =>
      String(url).endsWith("/healthz")
        ? new Response("ok", { status: 200 })
        : new Response("unauthorized", { status: 401 });
    const result = await sftpgoModule.probe(INSTANCE, { fetch: probeFetch });
    expect(result).toEqual({ ok: true, detail: "SFTPGo is reachable" });
  });

  it("authenticates and returns the username with a token", async () => {
    const fake = server();
    const result = await sftpgoModule.authenticate(
      INSTANCE,
      { username: "alice", password: "secret" },
      { fetch: fake.fetch },
    );
    expect(result.externalUsername).toBe("alice");
    expect(result.token?.token).toEqual(expect.any(String));
    expect(result.token?.expiresAt).toBeInstanceOf(Date);
  });

  it("fills the username from the expected one and refuses a different one", async () => {
    const fake = server();
    const result = await sftpgoModule.authenticate(
      INSTANCE,
      { password: "secret" },
      { fetch: fake.fetch, expectedUsername: "alice" },
    );
    expect(result.externalUsername).toBe("alice");
    expect(
      await kindOf(
        sftpgoModule.authenticate(
          INSTANCE,
          { username: "bob", password: "secret" },
          { fetch: fake.fetch, expectedUsername: "alice" },
        ),
      ),
    ).toBe("unauthorized");
    expect(
      await kindOf(
        sftpgoModule.authenticate(INSTANCE, { password: "secret" }, { fetch: fake.fetch }),
      ),
    ).toBe("unauthorized");
  });

  it("maps a wrong password and an unreachable server to storage errors", async () => {
    const fake = server();
    expect(
      await kindOf(
        sftpgoModule.authenticate(
          INSTANCE,
          { username: "alice", password: "wrong" },
          { fetch: fake.fetch },
        ),
      ),
    ).toBe("unauthorized");
    const down: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    expect(
      await kindOf(
        sftpgoModule.authenticate(
          INSTANCE,
          { username: "alice", password: "secret" },
          { fetch: down },
        ),
      ),
    ).toBe("upstream_unavailable");
  });

  it("mints a token from a stored credential", async () => {
    const fake = server();
    const token = await sftpgoModule.mint?.(
      INSTANCE,
      { externalUsername: "alice", credential: { password: "secret" } },
      { fetch: fake.fetch },
    );
    expect(token?.token).toEqual(expect.any(String));
  });

  it("builds storage that retries once with a fresh token on 401", async () => {
    const fake = server();
    const good = await createSftpgoClient({ baseUrl: INSTANCE.baseUrl, fetch: fake.fetch }).login({
      username: "alice",
      password: "secret",
    });
    let calls = 0;
    const session: StorageSession = {
      externalUsername: "alice",
      getCredential: async () => ({ password: "secret" }),
      getToken: vi.fn(async () => {
        calls += 1;
        return calls === 1 ? "expired-token" : good.accessToken;
      }),
      invalidateToken: vi.fn(async () => {}),
    };
    const storage = sftpgoModule.createStorage(INSTANCE, session, { fetch: fake.fetch });
    const entries = await storage.list("/");
    expect(entries.map((entry) => entry.name)).toEqual(["hello.txt"]);
    expect(session.invalidateToken).toHaveBeenCalledTimes(1);
    expect(session.getToken).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the session has no token", async () => {
    const fake = server();
    const session: StorageSession = {
      externalUsername: "alice",
      getCredential: async () => ({}),
      getToken: async () => null,
      invalidateToken: async () => {},
    };
    const storage = sftpgoModule.createStorage(INSTANCE, session, { fetch: fake.fetch });
    expect(await kindOf(storage.list("/"))).toBe("unauthorized");
  });
});

it.each([false, true])("only retries replayable uploads (bytes=%s)", async (replayable) => {
  const session: StorageSession = {
    externalUsername: "alice",
    getCredential: async () => ({}),
    getToken: vi.fn(async () => "token"),
    invalidateToken: vi.fn(async () => {}),
  };
  const received: string[] = [];
  const uploadFetch: typeof fetch = async (_url, init) => {
    received.push(await new Response(init?.body).text());
    return received.length === 1
      ? new Response("expired", { status: 401 })
      : new Response(null, { status: 201 });
  };
  const storage = sftpgoModule.createStorage(INSTANCE, session, { fetch: uploadFetch });
  const body = replayable
    ? new TextEncoder().encode("payload")
    : (new Response("payload").body ?? new ReadableStream<Uint8Array>());
  expect(await kindOf(storage.upload("/file.txt", body))).toBe(replayable ? null : "unauthorized");
  expect(received).toEqual(replayable ? ["payload", "payload"] : ["payload"]);
  expect(session.invalidateToken).toHaveBeenCalledTimes(1);
  expect(session.getToken).toHaveBeenCalledTimes(replayable ? 2 : 1);
});

it("maps a proxy's invalid JSON success to upstream unavailable", async () => {
  const session: StorageSession = {
    externalUsername: "alice",
    getCredential: async () => ({}),
    getToken: async () => "token",
    invalidateToken: async () => {},
  };
  const storage = sftpgoModule.createStorage(INSTANCE, session, {
    fetch: async () => new Response("<html>proxy failure</html>"),
  });
  expect(await kindOf(storage.list("/"))).toBe("upstream_unavailable");
});
