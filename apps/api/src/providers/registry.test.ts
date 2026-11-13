import { createMemoryRepos } from "@fdrive/db/testing";
import { describe, expect, it } from "vitest";
import { localModuleFixture } from "../local/test-fixtures/index.ts";
import { createProviderModules, isProviderType, moduleFor } from "./registry.ts";

/** A deployment with a files folder (`FDRIVE_STORAGE_ROOT`). */
function withLocal() {
  const local = localModuleFixture(createMemoryRepos());
  return createProviderModules({ local: { root: local.root, users: local.users } });
}

describe("createProviderModules", () => {
  const modules = Object.entries(withLocal());

  it("has the files folder only when the deployment configures one", () => {
    expect(createProviderModules()).toEqual({});
    expect(modules.map(([type]) => type)).toEqual(["local"]);
    expect(moduleFor("local", {})).toBeNull();
    expect(moduleFor("local", withLocal())?.deploymentManaged).toBe(true);
  });

  it.each(modules)("%s is keyed by its own type", (type, module) => {
    expect(module.type).toBe(type);
    expect(isProviderType(type)).toBe(true);
  });

  // The flag is the type-level summary the login form reads; the strategy
  // is what the API dispatches on. They must agree, or a login is promised a
  // feature its routes refuse (or the reverse).
  it.each(modules)("%s's shares flag agrees with its share strategy", (_type, module) => {
    expect(module.capabilities.shares).toBe(module.shares !== "none");
  });

  it.each(modules)("%s's trash flag agrees with its trash strategy", (_type, module) => {
    expect(module.capabilities.trash).toBe(module.trash !== "none");
  });

  it("knows no other type, including the retired SFTPGo, WebDAV and S3", () => {
    for (const type of ["dropbox", "sftpgo", "webdav", "s3"]) {
      expect(isProviderType(type)).toBe(false);
      expect(moduleFor(type, withLocal())).toBeNull();
    }
  });
});
