import { ConflictError } from "@fdrive/db";
import { createMemoryRepos } from "@fdrive/db/testing";
import { webdavModule } from "@fdrive/webdav";
import { describe, expect, it, vi } from "vitest";
import { localModuleFixture } from "../local/test-fixtures/index.ts";
import type { SystemEventLog } from "../system/event-log.js";
import { createProviderModules } from "./registry.js";
import { createProviderService, hostLabel } from "./service.js";
import {
  fakeProviderModule,
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

/** A deployment with a local folder: the local module beside WebDAV and S3. */
function localHarness(options: MemoryProviderServiceOptions & { indexRoot?: string | null } = {}) {
  const repos = createMemoryRepos();
  const local = localModuleFixture(repos, { indexRoot: options.indexRoot ?? null });
  const modules = { ...createProviderModules(), local: local.module };
  const events: string[] = [];
  const service = memoryProviderService(repos, {
    ...options,
    fetch: options.fetch ?? probeFetch(),
    clock: () => new Date("2026-09-10T00:00:00Z"),
    eventLog: {
      record: (subsystem, level, message) => events.push(`${subsystem}:${level}:${message}`),
    },
    modules,
  });
  return { repos, service, events, local };
}

describe("hostLabel", () => {
  it("uses the endpoint host and tolerates a non-URL", () => {
    expect(hostLabel("https://dav.internal:9443/base")).toBe("dav.internal:9443");
    expect(hostLabel("not a url")).toBe("not a url");
  });
});

describe("createProviderService: rows", () => {
  it("creates a validated, labelled provider and lists, resolves and views it", async () => {
    const h = harness({ indexRootNames: ["files"] });
    const created = await h.service.create({
      type: "webdav",
      label: "Home",
      baseUrl: "http://dav:8080",
      config: { desktopWriteMode: "apache-webdav-exclusive" },
    });
    expect(created).toMatchObject({
      type: "webdav",
      label: "Home",
      enabled: true,
      managedByEnv: false,
      config: { desktopWriteMode: "apache-webdav-exclusive" },
    });
    expect(await h.service.list()).toHaveLength(1);
    expect(await h.service.enabled()).toHaveLength(1);
    expect((await h.service.defaultProvider())?.id).toBe(created.id);
    const resolved = await h.service.resolve(created.id);
    expect(resolved.module.type).toBe("webdav");
    expect(resolved.instance).toEqual({
      id: created.id,
      baseUrl: "http://dav:8080",
      config: { desktopWriteMode: "apache-webdav-exclusive" },
    });
    expect(h.service.labelFor(created)).toBe("Home");
    expect(h.service.publicView(created)).toMatchObject({
      id: created.id,
      type: "webdav",
      label: "Home",
      credentialFields: webdavModule.credentialFields,
      capabilities: webdavModule.capabilities,
    });
    expect(await h.service.adminView(created)).toMatchObject({
      id: created.id,
      baseUrl: "http://dav:8080",
      config: { desktopWriteMode: "apache-webdav-exclusive" },
      identityCount: 0,
      reachable: true,
      checkedAt: "2026-09-10T00:00:00.000Z",
      createdAt: expect.any(String),
    });
    expect(h.service.types().map((type) => type.type)).toEqual(["webdav", "s3"]);
    // WebDAV is never indexed, whatever roots the deployment has; Trash is
    // off until its settings switch it on.
    expect(await h.service.capabilitiesFor(resolved)).toEqual({
      ...webdavModule.capabilities,
      trash: false,
    });
    expect(h.events).toEqual(["general:info:Storage provider added: Home"]);
  });

  it("falls back to the endpoint host as label for known callers only", async () => {
    const h = harness();
    const created = await h.service.create({
      type: "webdav",
      label: "x",
      baseUrl: "http://dav:8080",
    });
    const unlabeled = await h.repos.providers.update(created.id, { label: "" });
    if (unlabeled === null) throw new Error("vanished");
    expect(h.service.labelFor(unlabeled)).toBe("dav:8080");
    expect((await h.service.adminView(unlabeled))?.label).toBe("dav:8080");
    // The public view is served without a session, so it never names the host.
    expect(h.service.publicView(unlabeled)?.label).toBe("");
    // A row of a type the build no longer has is named by its address.
    const retired = await h.repos.providers.ensure({ type: "sftpgo", baseUrl: "http://old:8080" });
    expect(h.service.labelFor(retired)).toBe("old:8080");
  });

  it("prefers the env-pinned row as the default over an older enabled one", async () => {
    const h = harness();
    const older = await h.service.create({ type: "webdav", label: "a", baseUrl: "http://a" });
    const pinned = await h.service.create(
      { type: "webdav", label: "env", baseUrl: "http://env:8080" },
      { managedByEnv: true },
    );
    expect((await h.service.defaultProvider())?.id).toBe(pinned.id);
    await h.service.update(pinned.id, { enabled: false });
    expect((await h.service.defaultProvider())?.id).toBe(older.id);
  });

  it("refuses an unknown type, a bad config, and a duplicate endpoint", async () => {
    const h = harness();
    await expect(
      h.service.create({ type: "gdrive" as "webdav", label: "x", baseUrl: "http://a" }),
    ).rejects.toMatchObject({ kind: "bad_request" });
    // The local folder is a known type, but a deployment without one has no module for it.
    await expect(
      h.service.create({ type: "local", label: "x", baseUrl: "http://a" }),
    ).rejects.toMatchObject({ kind: "bad_request", message: "unknown provider type: local" });
    await expect(
      h.service.create({
        type: "webdav",
        label: "x",
        baseUrl: "http://a",
        config: { unknown: "field" },
      }),
    ).rejects.toMatchObject({ kind: "bad_request", details: { issues: expect.any(Array) } });
    await h.service.create({ type: "webdav", label: "x", baseUrl: "http://a" });
    await expect(
      h.service.create({ type: "webdav", label: "y", baseUrl: "http://a" }),
    ).rejects.toMatchObject({ kind: "conflict" });
  });

  it("propagates creation failures and reports a missing update target", async () => {
    const h = harness();
    vi.spyOn(h.repos.providers, "create").mockRejectedValueOnce(new Error("insert failed"));
    await expect(
      h.service.create({ type: "webdav", label: "x", baseUrl: "http://a" }),
    ).rejects.toThrow("insert failed");
    const row = await h.service.create({ type: "webdav", label: "y", baseUrl: "http://b" });
    vi.spyOn(h.repos.providers, "update").mockResolvedValueOnce(null);
    await expect(h.service.update(row.id, { label: "z" })).rejects.toMatchObject({
      kind: "not_found",
    });
    vi.spyOn(h.repos.providers, "update").mockRejectedValueOnce(new Error("update failed"));
    await expect(h.service.update(row.id, { label: "z" })).rejects.toThrow("update failed");
  });

  it("allows only one concurrent create without overwriting the winner", async () => {
    const h = harness();
    const results = await Promise.allSettled(
      ["first", "second"].map((label) =>
        h.service.create({ type: "webdav", label, baseUrl: "http://racing" }),
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
    const foreign = await h.repos.providers.ensure({ type: "sftpgo", baseUrl: "http://g" });
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
      { type: "webdav", label: "x", baseUrl: "http://a" },
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
    const row = await h.service.create({ type: "webdav", label: "x", baseUrl: "http://a" });
    const updated = await h.service.update(row.id, {
      label: "Renamed",
      config: { desktopWriteMode: "apache-webdav-exclusive" },
      enabled: false,
    });
    expect(updated).toMatchObject({
      label: "Renamed",
      config: { desktopWriteMode: "apache-webdav-exclusive" },
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
    const other = await h.service.create({ type: "webdav", label: "o", baseUrl: "http://o" });
    await expect(h.service.update(other.id, { baseUrl: "http://b" })).rejects.toMatchObject({
      kind: "conflict",
      message: "a provider with this endpoint already exists",
    });
    // A constraint the database still finds is reported as a conflict too.
    vi.spyOn(h.repos.providers, "update").mockRejectedValueOnce(
      new ConflictError("unique violation"),
    );
    await expect(h.service.update(other.id, { label: "clash" })).rejects.toMatchObject({
      kind: "conflict",
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
    const unused = await h.service.create({ type: "webdav", label: "u", baseUrl: "http://u" });
    const used = await h.service.create({ type: "webdav", label: "v", baseUrl: "http://v" });
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
    await expect(h.service.remove(used.id)).rejects.toMatchObject({
      kind: "forbidden",
      message: expect.stringContaining("FDRIVE_STORAGE_ROOT"),
    });
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
    const row = await h.service.create({ type: "webdav", label: "x", baseUrl: "http://a" });
    expect(await h.service.probe(row.id)).toEqual({
      ok: true,
      detail: "WebDAV is reachable (class 1, 2)",
    });
    expect(await h.service.probe({ type: "webdav", baseUrl: "http://b" })).toMatchObject({
      ok: true,
    });
    await expect(h.service.probe("00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({
      kind: "not_found",
    });
    await expect(
      h.service.probe({ type: "webdav", baseUrl: "http://b", config: { nope: "x" } }),
    ).rejects.toMatchObject({ kind: "bad_request" });
    const down = harness({ fetch: probeFetch(false) });
    const unreachable = await down.service.create({
      type: "webdav",
      label: "x",
      baseUrl: "http://a",
    });
    expect((await down.service.adminView(unreachable))?.reachable).toBe(false);
  });

  it("uses injected modules instead of the registry", async () => {
    const repos = createMemoryRepos();
    const custom = fakeProviderModule({ label: "Custom storage" });
    const service = createProviderService({
      repos,
      fetch: probeFetch(),
      clock: () => new Date(),
      environment: { indexRootNames: [] },
      modules: { webdav: custom },
    });
    expect(service.types().map((type) => type.label)).toEqual(["Custom storage"]);
  });
});

describe("createProviderService: the local folder", () => {
  it("names the folder by its module, hides its stored address, and offers it in no form", async () => {
    const h = localHarness();
    await h.service.seedFromEnvironment();
    const [row] = await h.service.list();
    if (row === undefined) throw new Error("not seeded");
    expect(row).toMatchObject({ type: "local", baseUrl: "local", label: "" });
    expect(h.service.labelFor(row)).toBe("Local folder");
    expect(await h.service.adminView(row)).toMatchObject({
      type: "local",
      label: "Local folder",
      baseUrl: "",
      managedByEnv: true,
      // The temporary folder exists and is writable.
      reachable: true,
    });
    expect(h.service.publicView(row)).toMatchObject({ type: "local", label: "" });
    // An administrator's own label wins.
    const labelled = await h.service.update(row.id, { label: "Family files" });
    expect(h.service.labelFor(labelled)).toBe("Family files");
    // System > Storage can add WebDAV and S3, never another local folder.
    expect(h.service.types().map((type) => type.type)).toEqual(["webdav", "s3"]);
    await expect(
      h.service.create({ type: "local", label: "Another", baseUrl: "http://elsewhere" }),
    ).rejects.toMatchObject({
      kind: "bad_request",
      message: "Local folder is set up by the deployment",
    });
    // Its address is the deployment's to change, not an administrator's.
    await expect(h.service.update(row.id, { baseUrl: "http://elsewhere" })).rejects.toMatchObject({
      kind: "forbidden",
    });
  });

  it("is indexed only when the root it is read under is configured", async () => {
    const indexed = localHarness({ indexRoot: "files", indexRootNames: ["files"] });
    await indexed.service.seedFromEnvironment();
    const [row] = await indexed.service.list();
    if (row === undefined) throw new Error("not seeded");
    expect(await indexed.service.capabilitiesFor(await indexed.service.resolve(row.id))).toEqual({
      zip: true,
      setModifiedAt: true,
      atomicMove: true,
      trash: false,
      shares: true,
      office: true,
      index: true,
      shareWithPeople: true,
    });
    const elsewhere = localHarness({
      indexRoot: "files",
      indexRootNames: ["photos"],
      trashEnabled: async () => true,
    });
    await elsewhere.service.seedFromEnvironment();
    const [other] = await elsewhere.service.list();
    if (other === undefined) throw new Error("not seeded");
    expect(
      await elsewhere.service.capabilitiesFor(await elsewhere.service.resolve(other.id)),
    ).toMatchObject({ index: false, trash: true });
    const unindexed = localHarness({ indexRoot: null, indexRootNames: ["files"] });
    await unindexed.service.seedFromEnvironment();
    const [plain] = await unindexed.service.list();
    if (plain === undefined) throw new Error("not seeded");
    expect(
      await unindexed.service.capabilitiesFor(await unindexed.service.resolve(plain.id)),
    ).toMatchObject({ index: false });
  });

  it("keeps Trash off for a module without one even when its settings enable it", async () => {
    const h = harness({ trashEnabled: async () => true });
    const row = await h.service.create({ type: "webdav", label: "x", baseUrl: "http://a" });
    const resolved = await h.service.resolve(row.id);
    expect(await h.service.capabilitiesFor(resolved)).toMatchObject({ trash: true });
    expect(
      await h.service.capabilitiesFor({
        ...resolved,
        module: { ...resolved.module, trash: "none" },
      }),
    ).toMatchObject({ trash: false });
  });
});

describe("createProviderService: seedFromEnvironment", () => {
  it("creates and pins the local folder's row, and leaves it alone afterwards", async () => {
    const h = localHarness();
    await h.service.seedFromEnvironment();
    const [row] = await h.service.list();
    expect(row).toMatchObject({
      type: "local",
      baseUrl: "local",
      managedByEnv: true,
      enabled: true,
    });
    expect((await h.service.defaultProvider())?.id).toBe(row?.id);
    // Idempotent, and an administrator's label survives restarts.
    await h.repos.providers.update(row?.id ?? "", { label: "Home storage" });
    await h.service.seedFromEnvironment();
    expect(await h.service.list()).toHaveLength(1);
    expect((await h.service.list())[0]?.label).toBe("Home storage");
    expect(h.events).toEqual([]);
  });

  it("leaves a row an admin disabled alone across restarts", async () => {
    const h = localHarness();
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

  it("pins an existing local row without changing whether it is enabled", async () => {
    const h = localHarness();
    const row = await h.repos.providers.ensure({ type: "local", baseUrl: "local" });
    await h.repos.providers.update(row.id, { managedByEnv: false, enabled: false });
    await h.service.seedFromEnvironment();
    expect(await h.repos.providers.get(row.id)).toMatchObject({
      managedByEnv: true,
      enabled: false,
    });
    expect(await h.service.list()).toHaveLength(1);
  });

  it("disables and unpins the SFTPGo row the local folder replaced, keeping its logins", async () => {
    const h = localHarness();
    const stale = await h.repos.providers.ensure({ type: "sftpgo", baseUrl: "http://old:8080" });
    await h.repos.providers.update(stale.id, { managedByEnv: true, enabled: true });
    const account = await h.repos.accounts.create({ displayName: "Alice" });
    const identity = await h.repos.identities.create({
      accountId: account.id,
      providerId: stale.id,
      externalUsername: "alice",
    });
    // An administrator's own WebDAV row is not the deployment's to touch.
    const added = await h.service.create({ type: "webdav", label: "Team", baseUrl: "http://dav" });
    await h.service.seedFromEnvironment();
    expect(await h.repos.providers.get(stale.id)).toMatchObject({
      managedByEnv: false,
      enabled: false,
    });
    expect(await h.repos.providers.get(added.id)).toMatchObject({ enabled: true });
    expect((await h.repos.identities.get(identity.id))?.providerId).toBe(stale.id);
    const local = (await h.service.list()).find((row) => row.type === "local");
    expect((await h.service.defaultProvider())?.id).toBe(local?.id);
    expect(h.events).toContain(
      "general:info:Storage provider disabled: old:8080 (the deployment no longer configures it)",
    );
  });

  it("disables the local row once the deployment no longer serves a folder", async () => {
    const h = harness();
    const row = await h.repos.providers.ensure({ type: "local", baseUrl: "local" });
    await h.repos.providers.update(row.id, { managedByEnv: true, enabled: true });
    await h.service.seedFromEnvironment();
    expect(await h.repos.providers.get(row.id)).toMatchObject({
      managedByEnv: false,
      enabled: false,
    });
    expect(h.events).toEqual([
      "general:info:Storage provider disabled: local (the deployment no longer configures it)",
    ]);
  });

  it("does nothing without a local folder or pinned rows", async () => {
    const h = harness();
    const added = await h.service.create({ type: "webdav", label: "Team", baseUrl: "http://dav" });
    await h.service.seedFromEnvironment();
    expect(await h.service.list()).toEqual([added]);
    expect(h.events).toEqual(["general:info:Storage provider added: Team"]);
  });
});
