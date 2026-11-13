import { expect, it } from "vitest";
import { makeIdentity } from "@/test-fixtures/identity";
import { loginDisplay } from "./login-display";

it("headlines the username and names the storage beneath", () => {
  expect(loginDisplay(makeIdentity({ username: "ada", providerLabel: "Home storage" }))).toEqual({
    title: "ada",
    detail: "Home storage",
  });
});

it("falls back to the product name when the storage has no name", () => {
  expect(loginDisplay(makeIdentity({ username: "ada", providerLabel: "" }))).toEqual({
    title: "ada",
    detail: "fdrive",
  });
});
