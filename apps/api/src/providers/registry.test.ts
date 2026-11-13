import { createMemoryRepos } from "@fdrive/db/testing";
import { describe, expect, it } from "vitest";
import { localModuleFixture } from "../local/test-fixtures/index.ts";
import { createProviderModules, isProviderType, moduleFor, PROVIDER_MODULES } from "./registry.ts";

/** Every module one deployment can have: the local folder joins WebDAV and S3. */
function withLocal() {
  const local = localModuleFixture(createMemoryRepos());
  return createProviderModules({ local: { root: local.root, users: local.users } });
}

describe("PROVIDER_MODULES", () => {
  const modules = Object.entries(withLocal());

  it("has WebDAV and S3 on every deployment, and the local folder only when configured", () => {
    expect(Object.keys(PROVIDER_MODULES)).toEqual(["webdav", "s3"]);
    expect(modules.map(([type]) => type)).toEqual(["local", "webdav", "s3"]);
    expect(moduleFor("local")).toBeNull();
    expect(moduleFor("local", withLocal())?.deploymentManaged).toBe(true);
  });

  it.each(modules)("%s is keyed by its own type", (type, module) => {
    expect(module.type).toBe(type);
    expect(isProviderType(type)).toBe(true);
  });

  it.each(Object.entries(PROVIDER_MODULES))(
    "%s is the default module for its type",
    (type, module) => {
      expect(moduleFor(type)).toBe(module);
    },
  );

  // The flag is the type-level summary System > Storage and the login form
  // read; the strategy is what the API dispatches on. They must agree, or a
  // login is promised a feature its routes refuse (or the reverse).
  it.each(modules)("%s's shares flag agrees with its share strategy", (_type, module) => {
    expect(module.capabilities.shares).toBe(module.shares !== "none");
  });

  it.each(modules)("%s's trash flag agrees with its trash strategy", (_type, module) => {
    expect(module.capabilities.trash).toBe(module.trash !== "none");
  });

  it("knows no other type, including the retired SFTPGo", () => {
    for (const type of ["dropbox", "sftpgo"]) {
      expect(isProviderType(type)).toBe(false);
      expect(moduleFor(type)).toBeNull();
    }
  });
});
