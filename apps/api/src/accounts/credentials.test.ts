import { ROUTES } from "@fdrive/contracts";
import { StorageError } from "@fdrive/core";
import { expect, it, vi } from "vitest";
import { createLoginLimiter } from "../auth/login-limiter.js";
import { authHarness } from "../auth/test-fixtures/index.ts";
import { ApiHttpError } from "../errors.js";
import { fakeProviderModule, seedProviderRow } from "../providers/test-fixtures/index.ts";
import { verifyCredentials } from "./credentials.ts";

/** The harness's files folder, signing in through a fake module shaped by `overrides`. */
function folderSigningInWith(overrides: Parameters<typeof fakeProviderModule>[0]) {
  return { local: fakeProviderModule({ deploymentManaged: true, ...overrides }) };
}
it("fails closed on provider changes and maps verification errors without database mutation", async () => {
  const h = authHarness();
  await h.seeded;
  const input = { credential: { username: "alice", password: "alice-pass" }, ip: "test" };
  const resolve = h.providers.resolve.bind(h.providers);
  vi.spyOn(h.providers, "resolve")
    .mockImplementationOnce(resolve)
    .mockRejectedValueOnce(
      new ApiHttpError("upstream_unavailable", "storage provider unavailable"),
    );
  await expect(verifyCredentials(h.deps, input)).rejects.toMatchObject({
    kind: "unauthorized",
  });
  expect(await h.repos.identities.listAll()).toEqual([]);
  // A row re-addressed while the upstream login was in flight is a change
  // too: the password was verified by the old server, not the new one.
  const seededRow = await h.seeded;
  const realVerify = h.users.verify.bind(h.users);
  vi.spyOn(h.users, "verify").mockImplementationOnce(async (username, password) => {
    await h.repos.providers.update(seededRow.id, { baseUrl: "http://moved.test" });
    return realVerify(username, password);
  });
  await expect(verifyCredentials(h.deps, input)).rejects.toMatchObject({
    kind: "unauthorized",
    message: "storage provider changed; sign in again",
  });
  expect(await h.repos.identities.listAll()).toEqual([]);
  await h.repos.providers.update(seededRow.id, { baseUrl: seededRow.baseUrl });
  vi.spyOn(h.limiter, "check").mockReturnValueOnce({ allowed: false });
  await expect(verifyCredentials(h.deps, input)).rejects.toMatchObject({
    kind: "rate_limited",
    details: { retryAfterMs: 0 },
  });
  vi.spyOn(h.users, "verify").mockResolvedValueOnce({ result: "disabled" });
  await expect(verifyCredentials(h.deps, input)).rejects.toMatchObject({
    kind: "forbidden",
    message: "forbidden",
  });
  vi.spyOn(h.users, "verify").mockRejectedValueOnce(new Error("private upstream"));
  await expect(verifyCredentials(h.deps, input)).rejects.toMatchObject({
    kind: "upstream_unavailable",
  });
});

it("requires a provider id once several providers are enabled", async () => {
  const h = authHarness();
  await h.seeded;
  await seedProviderRow(h.repos, "http://second.test");
  await expect(
    verifyCredentials(h.deps, {
      credential: { username: "alice", password: "alice-pass" },
      ip: "test",
    }),
  ).rejects.toMatchObject({ kind: "bad_request" });
  expect(
    (
      await h.call(ROUTES.auth.login, {
        method: "POST",
        body: { credential: { username: "alice", password: "alice-pass" } },
      })
    ).status,
  ).toBe(400);
});

it("holds the per-address spray bound across a whole IPv6 /64, not per address", async () => {
  const h = authHarness();
  await h.seeded;
  // One machine routinely owns its entire /64, so keying the bound on the
  // address alone hands it a fresh allowance per attempt.
  const from = (host: number) => `2001:db8:1:2::${host.toString(16)}`;
  for (let host = 1; host <= 5; host += 1) {
    await expect(
      verifyCredentials(h.deps, {
        credential: { username: `user${host}`, password: "wrong" },
        ip: from(host),
      }),
    ).rejects.toMatchObject({ kind: "unauthorized" });
  }

  // A sixth address in that /64 is the same caller, even with a valid password...
  await expect(
    verifyCredentials(h.deps, {
      credential: { username: "alice", password: "alice-pass" },
      ip: from(6),
    }),
  ).rejects.toMatchObject({ kind: "rate_limited" });
  // ...while a neighbouring /64 is a different one.
  await expect(
    verifyCredentials(h.deps, {
      credential: { username: "alice", password: "alice-pass" },
      ip: "2001:db8:1:3::1",
    }),
  ).resolves.toMatchObject({ externalUsername: "alice" });
});

it("bounds one address block's share of limiter capacity so another address still signs in", async () => {
  const h = authHarness();
  await h.seeded;
  // A capacity this small stands in for the 10 000 default: what matters is
  // that one caller's footprint is its block's budget rather than a slot per
  // address it can source from.
  const limiter = createLoginLimiter({ clock: h.clock, capacity: 8, maxKeysPerGroup: 2 });
  const deps = { ...h.deps, limiter };
  for (let host = 1; host <= 40; host += 1) {
    await verifyCredentials(deps, {
      credential: { username: `ghost-${host}`, password: "wrong" },
      ip: `2001:db8:1:2::${host.toString(16)}`,
    }).catch(() => undefined);
  }

  await expect(
    verifyCredentials(deps, {
      credential: { username: "bob", password: "bob-pass" },
      ip: "203.0.113.50",
    }),
  ).resolves.toMatchObject({ externalUsername: "bob" });
  // The attacker's own block is still throttled, and so is a username it
  // hammers from a single address.
  await expect(
    verifyCredentials(deps, {
      credential: { username: "alice", password: "alice-pass" },
      ip: "2001:db8:1:2::1",
    }),
  ).rejects.toMatchObject({ kind: "rate_limited" });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await expect(
      verifyCredentials(deps, {
        credential: { username: "carol", password: "wrong" },
        ip: "203.0.113.51",
      }),
    ).rejects.toMatchObject({ kind: "unauthorized" });
  }
  await expect(
    verifyCredentials(deps, {
      credential: { username: "carol", password: "carol-pass" },
      ip: "203.0.113.51",
    }),
  ).rejects.toMatchObject({ kind: "rate_limited" });
});

it("passes the storage's own reason for refusing a user, and hides any other failure", async () => {
  let failure: unknown = new StorageError("forbidden", "refused", {
    details: { detail: "account locked by the server" },
  });
  const h = authHarness({
    modules: folderSigningInWith({
      authenticate: async () => {
        throw failure;
      },
    }),
  });
  const row = await h.seeded;
  const input = {
    providerId: row.id,
    credential: { username: "alice", password: "alice-pass" },
    ip: "test",
  };
  await expect(verifyCredentials(h.deps, input)).rejects.toMatchObject({
    kind: "forbidden",
    message: "account locked by the server",
  });
  failure = new Error("socket hang up at 10.0.0.5");
  await expect(verifyCredentials(h.deps, input)).rejects.toMatchObject({
    kind: "upstream_unavailable",
    message: "storage provider is unavailable",
  });
  expect(await h.repos.identities.listAll()).toEqual([]);
});
