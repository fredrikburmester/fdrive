import { expect, it } from "vitest";
import { createOfficeScopeLifetime } from "./office-write-scope-state.js";

it("permits active use and permanently rejects use after the scope closes", () => {
  const lifetime = createOfficeScopeLifetime();
  expect(() => lifetime.assertActive()).not.toThrow();
  lifetime.close();
  expect(() => lifetime.assertActive()).toThrow("Office write scope has ended");
  lifetime.close();
  expect(() => lifetime.assertActive()).toThrow("Office write scope has ended");
  const independent = createOfficeScopeLifetime();
  expect(() => independent.assertActive()).not.toThrow();
});
