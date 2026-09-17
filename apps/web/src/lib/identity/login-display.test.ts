import { expect, it } from "vitest";
import { makeIdentity } from "@/test-fixtures/identity";
import { KEY_LOGIN_TYPES, loginDisplay } from "./login-display";

it("headlines the username for a person's login and names the storage beneath", () => {
  expect(loginDisplay(makeIdentity({ username: "ada", providerLabel: "Home storage" }))).toEqual({
    title: "ada",
    detail: "Home storage",
  });
  expect(
    loginDisplay(makeIdentity({ providerType: "webdav", username: "ada", providerLabel: "NAS" })),
  ).toEqual({ title: "ada", detail: "NAS" });
});

it("headlines the storage name for a key login and keeps the key visible beneath", () => {
  expect(KEY_LOGIN_TYPES.has("s3")).toBe(true);
  expect(
    loginDisplay(
      makeIdentity({ providerType: "s3", username: "0041234abcdef", providerLabel: "Backblaze" }),
    ),
  ).toEqual({ title: "Backblaze", detail: "0041234abcdef" });
});

it("falls back to the provider type's product name when the storage has no label", () => {
  expect(
    loginDisplay(makeIdentity({ providerType: "s3", username: "key", providerLabel: "" })),
  ).toEqual({ title: "S3", detail: "key" });
  expect(loginDisplay(makeIdentity({ username: "ada", providerLabel: "" })).detail).toBe("SFTPGo");
});
