import { createMemoryRepos } from "@fdrive/db/testing";
import { createSftpgoModule, sftpgoModule } from "@fdrive/sftpgo";
import { describe, expect, it, vi } from "vitest";
import type { SystemEventLog } from "../system/event-log.js";
import { createProviderService, hostLabel } from "./service.js";
import {
  type MemoryProviderServiceOptions,
  memoryProviderService,
  probeFetch,
} from "./test-fixtures/index.ts";

function harness(options: MemoryProviderServiceOptions = {}) {
  const repos = createMemoryRepos();
  const events: string[] = [];
  const eventLog: SystemEventLog = {
    record: (subsystem, level, message) => {
      events.push(`${subsystem}:${level}:${message}`);
    },
  };
  const service = memoryProviderService(repos, {
    ...options,
    fetch: options.fetch ?? probeFetch(),
    clock: () => new Date("2026-09-10T00:00:00Z"),
    eventLog,
  });
  return { repos, service, events };
}

describe("hostLabel", () => {
  it("uses the endpoint host and tolerates a non-URL", () => {
    expect(hostLabel("https://sftpgo.internal:9443/base")).toBe("sftpgo.internal:9443");
    expect(hostLabel("not a url")).toBe("not a url");
  });
});

describe("createProviderService: rows", () => {
  it("creates a validated, labelled provider and lists, resolves and views it", async () => {
    const h = harness({ indexRootNames: ["sftpgo"] });
    const created = await h.service.create({
      type: "sftpgo",
      label: "Home",
      baseUrl: "http://sftpgo:8080",
      config: { homeTemplate: "sftpgo:/{username}" },
    });
    expect(created).toMatchObject({
      type: "sftpgo",
      label: "Home",
      enabled: true,
      managedByEnv: false,
      config: { homeTemplate: "sftpgo:/{username}" },
    });
    expect(await h.service.list()).toHaveLength(1);
    expect(await h.service.enabled()).toHaveLength(1);
    expect((await h.service.defaultProvider())?.id).toBe(created.id);
    const resolved = await h.service.resolve(created.id);
    expect(resolved.module.type).toBe("sftpgo");
    expect(resolved.instance).toEqual({
      id: created.id,
      baseUrl: "http://sftpgo:8080",
      config: { homeTemplate: "sftpgo:/{username}" },
    });
    expect(h.service.labelFor(created)).toBe("Home");
    expect(h.service.publicView(created)).toMatchObject({
      id: created.id,
      type: "sftpgo",
      label: "Home",
      credentialFields: sftpgoModule.credentialFields,
    });
    expect(await h.service.adminView(created)).toMatchObject({
      id: created.id,
      baseUrl: "http://sftpgo:8080",
      config: { homeTemplate: "sftpgo:/{username}" },
      identityCount: 0,
      reachable: true,
      checkedAt: "2026-09-10T00:00:00.000Z",
      createdAt: expect.any(String),
    });
    expect(h.service.types().map((type) => type.type)).toEqual(["sftpgo", "webdav"]);
    expect(await h.service.capabilitiesFor(resolved)).toEqual({
      ...sftpgoModule.capabilities,
      trash: false,
    });
    expect(h.events).toEqual(["general:info:Storage provider added: Home"]);
  });

  it("falls back to the endpoint host as label for known callers only", async () => {
    const h = harness();
    const created = await h.service.create({
      type: "sftpgo",
      label: "x",
      baseUrl: "http://sftpgo:8080",
    });
    const unlabeled = await h.repos.providers.update(created.id, { label: "" });
    if (unlabeled === null) throw new Error("vanished");
    expect(h.service.labelFor(unlabeled)).toBe("sftpgo:8080");
    expect((await h.service.adminView(unlabeled))?.label).toBe("sftpgo:8080");
    // The public view is served without a session, so it never names the host.
    expect(h.service.publicView(unlabeled)?.label).toBe("");
  });

  it("prefers the env-pinned row as the default over an older enabled one", async () => {
    const h = harness();
    const older = await h.service.create({ type: "sftpgo", label: "a", baseUrl: "http://a" });
    const pinned = await h.service.create(
      { type: "sftpgo", label: "env", baseUrl: "http://env:8080" },
      { managedByEnv: true },
    );
    expect((await h.service.defaultProvider())?.id).toBe(pinned.id);
    await h.service.update(pinned.id, { enabled: false });
    expect((await h.service.defaultProvider())?.id).toBe(older.id);
  });

  it("refuses an unknown type, a bad config, and a duplicate endpoint", async () => {
    const h = harness();
    await expect(
      h.service.create({ type: "gdrive" as "sftpgo", label: "x", baseUrl: "http://a" }),
    ).rejects.toMatchObject({ kind: "bad_request" });
    await expect(
      h.service.create({
        type: "sftpgo",
        label: "x",
        baseUrl: "http://a",
        config: { unknown: "field" },
      }),
    ).rejects.toMatchObject({ kind: "bad_request", details: { issues: expect.any(Array) } });
    await h.service.create({ type: "sftpgo", label: "x", baseUrl: "http://a" });
    await expect(
      h.service.create({ type: "sftpgo", label: "y", baseUrl: "http://a" }),
    ).rejects.toMatchObject({ kind: "conflict" });
  });

  it("propagates creation failures and reports a missing update target", async () => {
    const h = harness();
    vi.spyOn(h.repos.providers, "create").mockRejectedValueOnce(new Error("insert failed"));
    await expect(
      h.service.create({ type: "sftpgo", label: "x", baseUrl: "http://a" }),
    ).rejects.toThrow("insert failed");
    const row = await h.service.create({ type: "sftpgo", label: "y", baseUrl: "http://b" });
    vi.spyOn(h.repos.providers, "update").mockResolvedValueOnce(null);
    await expect(h.service.update(row.id, { label: "z" })).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("allows only one concurrent create without overwriting the winner", async () => {
    const h = harness();
    const results = await Promise.allSettled(
      ["first", "second"].map((label) =>
        h.service.create({ type: "sftpgo", label, baseUrl: "http://racing" }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { kind: "conflict" },
    });
    const winner = results.find((result) => result.status === "fulfilled");
    if (winner?.status !== "fulfilled") throw new Error("missing winner");
    expect(await h.repos.providers.get(winner.value.id)).toEqual(winner.value);
  });

  it("hides rows of a type this build does not know", async () => {
    const h = harness();
    const foreign = await h.repos.providers.ensure({ type: "gdrive", baseUrl: "http://g" });
    expect(await h.service.get(foreign.id)).toBeNull();
    expect(await h.service.enabled()).toEqual([]);
    expect(await h.service.defaultProvider()).toBeNull();
    expect(h.service.publicView(foreign)).toBeNull();
    expect(await h.service.adminView(foreign)).toBeNull();
    await expect(h.service.resolve(foreign.id)).rejects.toMatchObject({
      kind: "upstream_unavailable",
    });
    await expect(h.service.update(foreign.id, { label: "x" })).rejects.toMatchObject({
      kind: "bad_request",
    });
  });

  it("resolves disabled rows only on request, and identities through their rows", async () => {
    const h = harness();
    const row = await h.service.create(
      { type: "sftpgo", label: "x", baseUrl: "http://a" },
      { enabled: false },
    );
    await expect(h.service.resolve(row.id)).rejects.toMatchObject({
      kind: "upstream_unavailable",
    });
    expect((await h.service.resolve(row.id, { allowDisabled: true })).provider.id).toBe(row.id);
    await expect(h.service.resolve("00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({
      kind: "upstream_unavailable",
    });
    const account = await h.repos.accounts.create({ displayName: null });
    const identity = await h.repos.identities.create({
      accountId: account.id,
      providerId: row.id,
      externalUsername: "alice",
    });
    await expect(h.service.forIdentity(identity.id)).rejects.toMatchObject({
      kind: "upstream_unavailable",
    });
    await h.service.update(row.id, { enabled: true });
    expect((await h.service.forIdentity(identity.id)).identity.id).toBe(identity.id);
    await expect(
      h.service.forIdentity("00000000-0000-4000-8000-000000000001"),
    ).rejects.toMatchObject({ kind: "reauth_required" });
    expect((await h.service.adminView(row))?.identityCount).toBe(1);
  });

  it("updates label, config and enabled, and refuses re-addressing a used or pinned row", async () => {
    const h = harness();
    const row = await h.service.create({ type: "sftpgo", label: "x", baseUrl: "http://a" });
    const updated = await h.service.update(row.id, {
      label: "Renamed",
      config: { homeTemplate: "data:/{username}" },
      enabled: false,
    });
    expect(updated).toMatchObject({
      label: "Renamed",
      config: { homeTemplate: "data:/{username}" },
      enabled: false,
    });
    expect(h.events.at(-1)).toContain("Storage provider updated: Renamed");
    expect((await h.service.update(row.id, { baseUrl: "http://b" })).baseUrl).toBe("http://b");
    await expect(h.service.update(row.id, { config: { nope: "x" } })).rejects.toMatchObject({
      kind: "bad_request",
    });
    const account = await h.repos.accounts.create({ displayName: null });
    await h.repos.identities.create({
      accountId: account.id,
      providerId: row.id,
      externalUsername: "alice",
    });
    await expect(h.service.update(row.id, { baseUrl: "http://c" })).rejects.toMatchObject({
      kind: "conflict",
    });
    // The same address is not a change.
    expect((await h.service.update(row.id, { baseUrl: "http://b" })).baseUrl).toBe("http://b");
    // Another row's address is a conflict, not a unique-constraint crash.
    const other = await h.service.create({ type: "sftpgo", label: "o", baseUrl: "http://o" });
    await expect(h.service.update(other.id, { baseUrl: "http://b" })).rejects.toMatchObject({
      kind: "conflict",
      message: "a provider with this endpoint already exists",
    });
    await h.repos.providers.update(row.id, { managedByEnv: true });
    await expect(h.service.update(row.id, { baseUrl: "http://d" })).rejects.toMatchObject({
      kind: "forbidden",
    });
    await expect(
      h.service.update("00000000-0000-4000-8000-000000000000", { label: "x" }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("removes unused rows and refuses used or pinned ones", async () => {
    const h = harness();
    const unused = await h.service.create({ type: "sftpgo", label: "u", baseUrl: "http://u" });
    const used = await h.service.create({ type: "sftpgo", label: "v", baseUrl: "http://v" });
    const account = await h.repos.accounts.create({ displayName: null });
    await h.repos.identities.create({
      accountId: account.id,
      providerId: used.id,
      externalUsername: "alice",
    });
    await h.service.remove(unused.id);
    expect(await h.service.get(unused.id)).toBeNull();
    expect(h.events.at(-1)).toContain("Storage provider removed: u");
    await expect(h.service.remove(used.id)).rejects.toMatchObject({ kind: "conflict" });
    await h.repos.providers.update(used.id, { managedByEnv: true });
    await expect(h.service.remove(used.id)).rejects.toMatchObject({ kind: "forbidden" });
    await expect(h.service.remove("00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({
      kind: "not_found",
    });
    const boom = new Error("db down");
    vi.spyOn(h.repos.providers, "delete").mockRejectedValueOnce(boom);
    await h.repos.providers.update(used.id, { managedByEnv: false });
    await expect(h.service.remove(used.id)).rejects.toBe(boom);
  });

  it("probes saved rows and unsaved candidates", async () => {
    const h = harness();
    const row = await h.service.create({ type: "sftpgo", label: "x", baseUrl: "http://a" });
    expect(await h.service.probe(row.id)).toEqual({ ok: true, detail: "SFTPGo is reachable" });
    expect(await h.service.probe({ type: "sftpgo", baseUrl: "http://b" })).toMatchObject({
      ok: true,
    });
    await expect(h.service.probe("00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({
      kind: "not_found",
    });
    await expect(
      h.service.probe({ type: "sftpgo", baseUrl: "http://b", config: { nope: "x" } }),
    ).rejects.toMatchObject({ kind: "bad_request" });
  });

  it("derives capabilities from the module, trash settings and the row's own index root", async () => {
    const withRoots = harness({
      indexRootNames: ["sftpgo", "photos"],
      trashEnabled: async () => true,
    });
    const row = await withRoots.service.create({
      type: "sftpgo",
      label: "x",
      baseUrl: "http://a",
      config: { homeTemplate: "sftpgo:/{username}" },
    });
    expect(
      await withRoots.service.capabilitiesFor(await withRoots.service.resolve(row.id)),
    ).toEqual({ ...sftpgoModule.capabilities, trash: true, index: true, scopeMapping: true });
    // A second row whose home template names a root the indexer does not
    // read is not indexed, whatever the deployment-wide root list says.
    const unmapped = await withRoots.service.create({
      type: "sftpgo",
      label: "archive",
      baseUrl: "http://b",
      config: { homeTemplate: "archive:/{username}" },
    });
    expect(
      await withRoots.service.capabilitiesFor(await withRoots.service.resolve(unmapped.id)),
    ).toMatchObject({ index: false, scopeMapping: false });
    const moveModule = createSftpgoModule();
    const noTrash = { ...moveModule, trash: "none" as const };
    expect(
      await withRoots.service.capabilitiesFor({
        provider: row,
        module: noTrash,
        instance: { id: row.id, baseUrl: row.baseUrl, config: row.config },
      }),
    ).toMatchObject({ trash: false });
  });

  it("uses injected modules instead of the registry", async () => {
    const repos = createMemoryRepos();
    const custom = { ...sftpgoModule, label: "Custom SFTPGo" };
    const service = createProviderService({
      repos,
      fetch: probeFetch(),
      clock: () => new Date(),
      environment: { sftpgoUrl: undefined, homeTemplate: "sftpgo:/{username}", indexRootNames: [] },
      modules: { sftpgo: custom },
    });
    expect(service.types().map((type) => type.label)).toEqual(["Custom SFTPGo"]);
  });
});

describe("createProviderService: seedFromEnvironment", () => {
  it("creates and pins the SFTPGo provider named by SFTPGO_URL with the environment home template", async () => {
    const h = harness({ sftpgoUrl: "http://env:8080", homeTemplate: "env:/{username}" });
    await h.service.seedFromEnvironment();
    const [row] = await h.service.list();
    expect(row).toMatchObject({
      type: "sftpgo",
      baseUrl: "http://env:8080",
      managedByEnv: true,
      enabled: true,
      config: { homeTemplate: "env:/{username}" },
    });
    // Idempotent, and a stored template is never overwritten.
    await h.repos.providers.update(row?.id ?? "", {
      label: "Home storage",
      config: { homeTemplate: "kept:/{username}" },
    });
    await h.service.seedFromEnvironment();
    expect(await h.service.list()).toHaveLength(1);
    expect((await h.service.list())[0]?.config).toEqual({ homeTemplate: "kept:/{username}" });
    expect((await h.service.list())[0]?.label).toBe("Home storage");
    expect(h.events).toEqual([]);
  });

  it.each([
    ["http://env:8080", "http://env:8080/", true],
    ["http://env:8080/", "http://env:8080", true],
    ["http://env:8080/base/", "http://env:8080/base", false],
  ] as const)("keeps provider %s when the environment becomes %s", async (stored, env, enabled) => {
    const h = harness({ sftpgoUrl: env });
    const row = await h.repos.providers.ensure({ type: "sftpgo", baseUrl: stored });
    await h.repos.providers.update(row.id, {
      managedByEnv: true,
      enabled,
      config: { homeTemplate: "kept:/{username}" },
    });
    const account = await h.repos.accounts.create({ displayName: "Alice" });
    const identity = await h.repos.identities.create({
      accountId: account.id,
      providerId: row.id,
      externalUsername: "alice",
    });
    await h.service.seedFromEnvironment();
    expect(await h.service.list()).toEqual([
      expect.objectContaining({
        id: row.id,
        baseUrl: stored,
        managedByEnv: true,
        enabled,
        config: { homeTemplate: "kept:/{username}" },
      }),
    ]);
    expect((await h.repos.identities.get(identity.id))?.providerId).toBe(row.id);
    expect(h.events).toEqual([]);
  });

  it("prefers the already pinned row over an older equivalent spelling", async () => {
    const h = harness({ sftpgoUrl: "http://env:8080/" });
    const other = await h.repos.providers.ensure({ type: "sftpgo", baseUrl: "http://env:8080/" });
    const pinned = await h.repos.providers.ensure({ type: "sftpgo", baseUrl: "http://env:8080" });
    await h.repos.providers.update(pinned.id, { managedByEnv: true });
    await h.service.seedFromEnvironment();
    expect((await h.repos.providers.get(other.id))?.managedByEnv).toBe(false);
    expect((await h.service.defaultProvider())?.id).toBe(pinned.id);
    expect(await h.service.list()).toHaveLength(2);
  });

  it("leaves a row an admin disabled alone across restarts", async () => {
    const h = harness({ sftpgoUrl: "http://env:8080" });
    await h.service.seedFromEnvironment();
    const [row] = await h.service.list();
    if (row === undefined) throw new Error("not seeded");
    await h.service.update(row.id, { enabled: false });
    await h.service.seedFromEnvironment();
    expect(await h.repos.providers.get(row.id)).toMatchObject({
      managedByEnv: true,
      enabled: false,
    });
    expect(await h.service.enabled()).toEqual([]);
  });

  it("retires the row SFTPGO_URL moved away from and pins the one it names now", async () => {
    const h = harness({ sftpgoUrl: "http://env:8080" });
    const stale = await h.repos.providers.ensure({ type: "sftpgo", baseUrl: "http://old:8080" });
    await h.repos.providers.update(stale.id, { managedByEnv: true, enabled: true });
    await h.service.seedFromEnvironment();
    expect(await h.repos.providers.get(stale.id)).toMatchObject({
      managedByEnv: false,
      enabled: false,
    });
    const env = (await h.service.list()).find((row) => row.baseUrl === "http://env:8080");
    expect(env).toMatchObject({
      managedByEnv: true,
      enabled: true,
      config: { homeTemplate: "sftpgo:/{username}" },
    });
    expect((await h.service.defaultProvider())?.id).toBe(env?.id);
    expect(h.events).toEqual([
      "general:info:Storage provider disabled: old:8080 (SFTPGO_URL now names another server)",
    ]);
  });

  it("only unpins, and keeps enabled, a row when SFTPGO_URL is removed", async () => {
    const seeded = harness({ sftpgoUrl: "http://env:8080" });
    await seeded.service.seedFromEnvironment();
    const h = harness();
    const [row] = await seeded.service.list();
    if (row === undefined) throw new Error("not seeded");
    await h.repos.providers.ensure({ type: "sftpgo", baseUrl: row.baseUrl });
    const [copy] = await h.service.list();
    if (copy === undefined) throw new Error("not copied");
    await h.repos.providers.update(copy.id, { managedByEnv: true, enabled: true });
    await h.service.seedFromEnvironment();
    expect(await h.repos.providers.get(copy.id)).toMatchObject({
      managedByEnv: false,
      enabled: true,
    });
    expect(h.events).toEqual([
      "general:info:Storage provider unpinned: env:8080 (SFTPGO_URL is no longer set)",
    ]);
  });

  it("does nothing without an environment URL", async () => {
    const h = harness();
    await h.service.seedFromEnvironment();
    expect(await h.service.list()).toEqual([]);
  });
});
