import { describe, expect, it } from "vitest";
import { isProviderType, moduleFor, PROVIDER_MODULES } from "./registry.ts";

describe("PROVIDER_MODULES", () => {
  const modules = Object.entries(PROVIDER_MODULES);

  it.each(modules)("%s is keyed by its own type", (type, module) => {
    expect(module.type).toBe(type);
    expect(isProviderType(type)).toBe(true);
    expect(moduleFor(type)).toBe(module);
  });

  // The flag is the type-level summary System > Storage and the login form
  // read; the strategy is what the API dispatches on. They must agree, or a
  // login is promised a feature its routes refuse (or the reverse).
  it.each(modules)("%s's shares flag agrees with its share strategy", (_type, module) => {
    expect(module.capabilities.shares).toBe(module.shares !== "none");
  });

  it.each(modules)("%s's trash flag agrees with its trash strategy", (_type, module) => {
    expect(module.capabilities.trash).toBe(module.trash !== "none");
  });

  it("knows no other type", () => {
    expect(isProviderType("dropbox")).toBe(false);
    expect(moduleFor("dropbox")).toBeNull();
  });
});
