import type { ProviderInstance, StorageSession } from "@fdrive/core";
import { isStorageError } from "@fdrive/core";
import { describe, expect, it, vi } from "vitest";
import { createS3Client } from "./client.js";
import { createFakeS3Server } from "./fake/server.js";
import { createS3Module, S3_CONFIG_FIELDS, S3_CREDENTIAL_FIELDS, s3Module } from "./module.js";

const ALICE = { accessKeyId: "alice-key", secretAccessKey: "alice-secret" };
const INSTANCE: ProviderInstance = {
  id: "row",
  baseUrl: "http://s3.test/bucket/team",
  config: { region: "garage" },
};

async function kindOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return isStorageError(error) ? error.kind : `not a StorageError: ${String(error)}`;
  }
}

function session(secret: string): StorageSession {
  return {
    externalUsername: ALICE.accessKeyId,
    getCredential: async () => ({ username: "ignored", password: secret }),
    getToken: async () => null,
    invalidateToken: async () => undefined,
  };
}

describe("s3Module", () => {
  it("declares its type, fields, capabilities and Trash strategy", () => {
    expect(s3Module.type).toBe("s3");
    expect(s3Module.label).toBe("S3");
    expect(s3Module.configFields).toBe(S3_CONFIG_FIELDS);
    expect(s3Module.credentialFields).toBe(S3_CREDENTIAL_FIELDS);
    expect(s3Module.credentialFields.map((field) => field.name)).toEqual(["username", "password"]);
    expect(s3Module.capabilities).toEqual({
      zip: false,
      setModifiedAt: false,
      atomicMove: false,
      trash: true,
      shares: false,
      office: false,
      index: false,
      scopeMapping: false,
    });
    expect(s3Module.trash).toBe("move");
    expect(s3Module.mint).toBeUndefined();
  });

  it("probes the bucket unsigned", async () => {
    const server = createFakeS3Server({ keys: [] });
    expect(await s3Module.probe(INSTANCE, { fetch: server.fetch })).toMatchObject({ ok: true });
    expect(server.requests[0]?.headers.authorization).toBeUndefined();
  });
});

describe("authenticate", () => {
  it("verifies the key pair by listing one key under the prefix, signed for the region", async () => {
    const server = createFakeS3Server({ keys: [ALICE] });
    const result = await s3Module.authenticate(
      INSTANCE,
      { username: ALICE.accessKeyId, password: ALICE.secretAccessKey },
      { fetch: server.fetch },
    );
    expect(result).toEqual({ externalUsername: ALICE.accessKeyId });
    const request = server.requests.at(-1);
    expect(request?.url).toBe("http://s3.test/bucket/?list-type=2&max-keys=1&prefix=team%2F");
    expect(request?.headers.authorization).toContain("/garage/s3/aws4_request");
  });

  it("fills the access key from the expected username and refuses another one", async () => {
    const server = createFakeS3Server({ keys: [ALICE] });
    await expect(
      s3Module.authenticate(
        INSTANCE,
        { password: ALICE.secretAccessKey },
        { fetch: server.fetch, expectedUsername: ALICE.accessKeyId },
      ),
    ).resolves.toEqual({ externalUsername: ALICE.accessKeyId });
    expect(
      await kindOf(
        s3Module.authenticate(
          INSTANCE,
          { username: "bob-key", password: "x" },
          { fetch: server.fetch, expectedUsername: ALICE.accessKeyId },
        ),
      ),
    ).toBe("unauthorized");
    expect(await kindOf(s3Module.authenticate(INSTANCE, {}, { fetch: server.fetch }))).toBe(
      "unauthorized",
    );
    expect(
      await kindOf(
        s3Module.authenticate(INSTANCE, { username: ALICE.accessKeyId }, { fetch: server.fetch }),
      ),
    ).toBe("unauthorized");
  });

  it("maps a wrong secret, an unknown key and a denied prefix", async () => {
    const server = createFakeS3Server({
      keys: [
        ALICE,
        { accessKeyId: "bob-key", secretAccessKey: "bob-secret", denyPrefixes: ["team/"] },
      ],
    });
    expect(
      await kindOf(
        s3Module.authenticate(
          INSTANCE,
          { username: ALICE.accessKeyId, password: "wrong" },
          { fetch: server.fetch },
        ),
      ),
    ).toBe("unauthorized");
    expect(
      await kindOf(
        s3Module.authenticate(
          INSTANCE,
          { username: "nobody", password: "x" },
          { fetch: server.fetch },
        ),
      ),
    ).toBe("unauthorized");
    expect(
      await kindOf(
        s3Module.authenticate(
          INSTANCE,
          { username: "bob-key", password: "bob-secret" },
          { fetch: server.fetch },
        ),
      ),
    ).toBe("forbidden");
  });

  it("reports a missing bucket, a dead endpoint and a bad address as unavailable", async () => {
    const server = createFakeS3Server({ keys: [ALICE], buckets: ["other"] });
    const credential = { username: ALICE.accessKeyId, password: ALICE.secretAccessKey };
    const missing = await s3Module
      .authenticate(INSTANCE, credential, { fetch: server.fetch })
      .catch((error: unknown) => error);
    expect(missing).toMatchObject({
      kind: "upstream_unavailable",
      details: { code: "NoSuchBucket" },
    });
    expect(
      await kindOf(
        s3Module.authenticate(
          { ...INSTANCE, baseUrl: "http://elsewhere.test/bucket" },
          credential,
          { fetch: server.fetch },
        ),
      ),
    ).toBe("upstream_unavailable");
    expect(
      await kindOf(
        s3Module.authenticate({ ...INSTANCE, baseUrl: "http://s3.test/" }, credential, {
          fetch: server.fetch,
        }),
      ),
    ).toBe("upstream_unavailable");
  });
});

describe("createStorage", () => {
  it("acts as the bound access key and rebuilds the client when the secret changes", async () => {
    const server = createFakeS3Server({ keys: [ALICE], objects: { "bucket/team/a.txt": "a" } });
    let secret = "stale";
    const storage = s3Module.createStorage(
      INSTANCE,
      {
        externalUsername: ALICE.accessKeyId,
        getCredential: async () => ({ username: "someone-else", password: secret }),
        getToken: async () => null,
        invalidateToken: async () => undefined,
      },
      { fetch: server.fetch },
    );
    expect(await kindOf(storage.stat("/a.txt"))).toBe("unauthorized");
    secret = ALICE.secretAccessKey;
    expect(await storage.stat("/a.txt")).toMatchObject({ kind: "file", size: 1 });
    expect(await storage.stat("/a.txt")).toMatchObject({ kind: "file" });
    expect(
      server.requests.every((request) => request.headers.authorization?.includes("alice-key")),
    ).toBe(true);
    const missingSecret = s3Module.createStorage(
      INSTANCE,
      { ...session(""), getCredential: async () => ({}) },
      { fetch: server.fetch },
    );
    expect(await kindOf(missingSecret.stat("/a.txt"))).toBe("unauthorized");
    expect(() =>
      s3Module.createStorage({ ...INSTANCE, baseUrl: "http://s3.test" }, session("x"), {
        fetch: server.fetch,
      }),
    ).toThrow("S3 address is invalid");
  });

  it("uses an injected client factory", async () => {
    const server = createFakeS3Server({ keys: [ALICE], objects: { "bucket/team/a.txt": "a" } });
    const clientFor = vi.fn((_instance, endpoint, credential, ctx) =>
      createS3Client({ endpoint: endpoint.endpoint, region: "x", credential, fetch: ctx.fetch }),
    );
    const module = createS3Module({ clientFor });
    await module.authenticate(
      INSTANCE,
      { username: ALICE.accessKeyId, password: ALICE.secretAccessKey },
      { fetch: server.fetch },
    );
    const storage = module.createStorage(INSTANCE, session(ALICE.secretAccessKey), {
      fetch: server.fetch,
    });
    expect((await storage.list("/")).map((entry) => entry.name)).toEqual(["a.txt"]);
    expect(clientFor).toHaveBeenCalledTimes(2);
    expect(clientFor.mock.calls[1]?.[2]).toEqual(ALICE);
  });
});
