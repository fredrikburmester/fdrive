import { rmSync } from "node:fs";
import { createMemoryRepos } from "@fdrive/db/testing";
import { describe, expect, it, vi } from "vitest";
import { localModuleFixture } from "../local/test-fixtures/index.ts";
import { hostLabel } from "./service.js";
import {
  type MemoryProviderServiceOptions,
  memoryProviderService,
  seedProviderRow,
} from "./test-fixtures/index.ts";

/**
 * A provider service over in-memory repos. With `local` the deployment
 * serves a folder (`FDRIVE_STORAGE_ROOT`); without it, it has no storage.
 */
function harness(
  options: MemoryProviderServiceOptions & { local?: boolean; indexRoot?: string | null } = {},
) {
  const repos = createMemoryRepos();
  const local =
    options.local === false
      ? null
      : localModuleFixture(repos, { indexRoot: options.indexRoot ?? null });
  const events: string[] = [];
  const service = memoryProviderService(repos, {
    ...options,
    clock: () => new Date("2026-09-10T00:00:00Z"),
    eventLog: {
      record: (subsystem, level, message) => events.push(`${subsystem}:${level}:${message}`),
    },
    modules: local === null ? {} : { local: local.module },
  });
  return { repos, service, events, local };
}

/** The harness with its folder's row seeded, as the API leaves it at startup. */
async function seeded(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options);
  await h.service.seedFromEnvironment();
  const [row] = await h.service.list();
  if (row === undefined) throw new Error("not seeded");
  return { ...h, row };
}

describe("hostLabel", () => {
  it("uses the endpoint host and tolerates a non-URL", () => {
    expect(hostLabel("https://dav.internal:9443/base")).toBe("dav.internal:9443");
    expect(hostLabel("not a url")).toBe("not a url");
  });
});

describe("createProviderService: the files folder", () => {
  it("lists, resolves and views the folder's row, named by its module", async () => {
    const h = await seeded();
    const { row } = h;
    expect(row).toMatchObject({ type: "local", baseUrl: "local", label: "" });
    expect(await h.service.enabled()).toEqual([row]);
    expect((await h.service.defaultProvider())?.id).toBe(row.id);
    const resolved = await h.service.resolve(row.id);
    expect(resolved.module.type).toBe("local");
    expect(resolved.instance).toEqual({ id: row.id, baseUrl: "local", config: {} });
    expect(h.service.labelFor(row)).toBe("Local folder");
    expect(h.service.publicView(row)).toMatchObject({
      id: row.id,
      type: "local",
      // The public view is served without a session: only an admin-set label.
      label: "",
      credentialFields: resolved.module.credentialFields,
      capabilities: resolved.module.capabilities,
    });
    expect(await h.service.adminView(row)).toMatchObject({
      id: row.id,
      type: "local",
      label: "Local folder",
      baseUrl: "",
      config: {},
      enabled: true,
      managedByEnv: true,
      identityCount: 0,
      // The temporary folder exists and is writable.
      reachable: true,
      checkedAt: "2026-09-10T00:00:00.000Z",
      createdAt: expect.any(String),
    });
  });

  it("reports the folder unreachable once it is gone", async () => {
    const h = await seeded();
    rmSync(h.local?.root ?? "", { recursive: true, force: true });
    expect((await h.service.adminView(h.row))?.reachable).toBe(false);
  });

  it("renames the folder, which the login page then shows", async () => {
    const h = await seeded();
    const renamed = await h.service.update(h.row.id, { label: "Family files" });
    expect(renamed.label).toBe("Family files");
    expect(h.service.labelFor(renamed)).toBe("Family files");
    expect(h.service.publicView(renamed)?.label).toBe("Family files");
    expect(h.events).toEqual(["general:info:Storage provider renamed: Family files"]);
    await expect(
      h.service.update("00000000-0000-4000-8000-000000000000", { label: "x" }),
    ).rejects.toMatchObject({ kind: "not_found" });
    vi.spyOn(h.repos.providers, "update").mockRejectedValueOnce(new Error("update failed"));
    await expect(h.service.update(h.row.id, { label: "z" })).rejects.toThrow("update failed");
  });

  it("is indexed only when the root it is read under is configured", async () => {
    const indexed = await seeded({ indexRoot: "files", indexRootNames: ["files"] });
    expect(
      await indexed.service.capabilitiesFor(await indexed.service.resolve(indexed.row.id)),
    ).toEqual({
      zip: true,
      setModifiedAt: true,
      atomicMove: true,
      trash: false,
      shares: true,
      office: true,
      index: true,
      shareWithPeople: true,
    });
    const elsewhere = await seeded({
      indexRoot: "files",
      indexRootNames: ["photos"],
      trashEnabled: async () => true,
    });
    expect(
      await elsewhere.service.capabilitiesFor(await elsewhere.service.resolve(elsewhere.row.id)),
    ).toMatchObject({ index: false, trash: true });
    const unindexed = await seeded({ indexRoot: null, indexRootNames: ["files"] });
    expect(
      await unindexed.service.capabilitiesFor(await unindexed.service.resolve(unindexed.row.id)),
    ).toMatchObject({ index: false });
  });

  it("keeps Trash off for a module without one even when its settings enable it", async () => {
    const h = await seeded({ trashEnabled: async () => true });
    const resolved = await h.service.resolve(h.row.id);
    expect(await h.service.capabilitiesFor(resolved)).toMatchObject({ trash: true });
    expect(
      await h.service.capabilitiesFor({
        ...resolved,
        module: { ...resolved.module, trash: "none" },
      }),
    ).toMatchObject({ trash: false });
  });
});

describe("createProviderService: rows", () => {
  it("prefers the pinned row as the default over an older enabled one", async () => {
    const h = harness();
    const older = await seedProviderRow(h.repos, "http://older");
    await h.service.seedFromEnvironment();
    const pinned = (await h.service.list()).find((row) => row.managedByEnv);
    expect((await h.service.defaultProvider())?.id).toBe(pinned?.id);
    await h.repos.providers.update(pinned?.id ?? "", { enabled: false });
    expect((await h.service.defaultProvider())?.id).toBe(older.id);
  });

  it("hides rows of a type this build no longer has and names them by their address", async () => {
    const h = await seeded();
    for (const type of ["sftpgo", "webdav", "s3"]) {
      const retired = await h.repos.providers.ensure({ type, baseUrl: `http://${type}:8080` });
      expect(h.service.labelFor(retired)).toBe(`${type}:8080`);
      expect(await h.service.get(retired.id)).toBeNull();
      expect(h.service.publicView(retired)).toBeNull();
      expect(await h.service.adminView(retired)).toBeNull();
      await expect(h.service.resolve(retired.id)).rejects.toMatchObject({
        kind: "upstream_unavailable",
      });
    }
    expect(await h.service.enabled()).toEqual([h.row]);
    expect((await h.service.defaultProvider())?.id).toBe(h.row.id);
  });

  it("resolves disabled rows only on request, and identities through their rows", async () => {
    const h = harness();
    const row = await seedProviderRow(h.repos, "http://a", { enabled: false });
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
    await h.repos.providers.update(row.id, { enabled: true });
    expect((await h.service.forIdentity(identity.id)).identity.id).toBe(identity.id);
    await expect(
      h.service.forIdentity("00000000-0000-4000-8000-000000000001"),
    ).rejects.toMatchObject({ kind: "reauth_required" });
    expect((await h.service.adminView(row))?.identityCount).toBe(1);
  });
});

describe("createProviderService: seedFromEnvironment", () => {
  it("creates and pins the folder's row, and keeps its label across restarts", async () => {
    const h = await seeded();
    expect(h.row).toMatchObject({
      type: "local",
      baseUrl: "local",
      managedByEnv: true,
      enabled: true,
    });
    await h.repos.providers.update(h.row.id, { label: "Home storage" });
    await h.service.seedFromEnvironment();
    expect(await h.service.list()).toHaveLength(1);
    expect((await h.service.list())[0]?.label).toBe("Home storage");
    expect(h.events).toEqual([]);
  });

  it("pins and enables an existing local row: only the deployment switches it", async () => {
    const h = harness();
    const row = await h.repos.providers.ensure({ type: "local", baseUrl: "local" });
    await h.repos.providers.update(row.id, { managedByEnv: false, enabled: false });
    await h.service.seedFromEnvironment();
    expect(await h.repos.providers.get(row.id)).toMatchObject({
      managedByEnv: true,
      enabled: true,
    });
    expect(await h.service.list()).toHaveLength(1);
  });

  it("disables the folder's row while the deployment serves none, and enables it again", async () => {
    const without = harness({ local: false });
    const row = await without.repos.providers.ensure({ type: "local", baseUrl: "local" });
    await without.repos.providers.update(row.id, { managedByEnv: true, enabled: true });
    await without.service.seedFromEnvironment();
    expect(await without.repos.providers.get(row.id)).toMatchObject({
      managedByEnv: false,
      enabled: false,
    });
    // Without a module the row is not storage: it is named by its address.
    expect(without.events).toEqual([
      "general:info:Storage provider disabled: local (the deployment no longer configures it)",
    ]);
    expect(await without.service.defaultProvider()).toBeNull();

    // The next start with `FDRIVE_STORAGE_ROOT` set serves its logins again.
    const local = localModuleFixture(without.repos);
    const again = memoryProviderService(without.repos, { modules: { local: local.module } });
    await again.seedFromEnvironment();
    expect(await without.repos.providers.get(row.id)).toMatchObject({
      managedByEnv: true,
      enabled: true,
    });
  });

  it("does nothing without a folder or pinned rows", async () => {
    const h = harness({ local: false });
    const row = await seedProviderRow(h.repos, "http://unpinned");
    await h.service.seedFromEnvironment();
    expect(await h.service.list()).toEqual([row]);
    expect(h.events).toEqual([]);
  });
});
