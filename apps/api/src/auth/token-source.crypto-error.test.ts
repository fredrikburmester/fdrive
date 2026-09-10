import type { Repos } from "@fdrive/db";
import { createMemoryRepos } from "@fdrive/db/testing";
import { sftpgoModule } from "@fdrive/sftpgo";
import { describe, expect, it, vi } from "vitest";

const NON_CRYPTO_ERROR = new Error("boom, not a CryptoError");

vi.mock("./crypto.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./crypto.js")>();
  return {
    ...actual,
    open: () => {
      throw NON_CRYPTO_ERROR;
    },
  };
});

const { parseMasterKey, seal } = await import("./crypto.js");
const { createTokenSource } = await import("./token-source.js");

const MASTER = parseMasterKey(Buffer.alloc(32, 3).toString("base64"));

describe("openOrReauth: non-CryptoError rethrow", () => {
  it("propagates an error from `open` that is not a CryptoError, unwrapped", async () => {
    const repos: Repos = createMemoryRepos();
    const provider = await repos.providers.ensure({
      type: "sftpgo",
      baseUrl: "http://sftpgo.fake",
    });
    const account = await repos.accounts.create({ displayName: "alice" });
    const identity = await repos.identities.create({
      accountId: account.id,
      providerId: provider.id,
      externalUsername: "alice",
    });
    const ciphertext = seal(
      MASTER,
      new TextEncoder().encode(JSON.stringify({ password: "x" })),
      identity.id,
    );
    await repos.credentials.put({ identityId: identity.id, ciphertext, keyId: "master-v1" });

    const tokenSource = createTokenSource({
      repos,
      providers: {
        forIdentity: async () => ({
          identity,
          provider,
          module: sftpgoModule,
          instance: { id: provider.id, baseUrl: provider.baseUrl, config: {} },
        }),
      },
      master: MASTER,
      clock: () => new Date(),
      fetch: vi.fn(),
    });

    await expect(tokenSource.get(identity.id)).rejects.toBe(NON_CRYPTO_ERROR);
  });
});
