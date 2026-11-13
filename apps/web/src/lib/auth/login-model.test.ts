import type { PublicProvider } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import { allCapabilities } from "@/lib/identity/capabilities";
import {
  buildCredential,
  confirmationFieldsFor,
  credentialComplete,
  credentialFieldsFor,
  DEFAULT_CREDENTIAL_FIELDS,
  loginSubtitle,
} from "./login-model";

const local: PublicProvider = {
  id: "00000000-0000-4000-8000-000000000001",
  type: "local",
  label: "files.example.org",
  credentialFields: [
    { name: "username", label: "User", kind: "text", required: true },
    { name: "password", label: "Password", kind: "password", required: true },
    { name: "otp", label: "Code", kind: "otp", required: false, transient: true },
  ],
  capabilities: allCapabilities(true),
};

describe("credentialFieldsFor", () => {
  it("uses the provider's fields, else the defaults", () => {
    expect(credentialFieldsFor(local)).toBe(local.credentialFields);
    expect(credentialFieldsFor(undefined)).toBe(DEFAULT_CREDENTIAL_FIELDS);
  });
});

describe("confirmationFieldsFor", () => {
  it("keeps only the secret fields and relabels them as the current login's", () => {
    const fields = confirmationFieldsFor(local.credentialFields);
    expect(fields.map((field) => field.name)).toEqual(["password", "otp"]);
    expect(fields.map((field) => field.label)).toEqual([
      "Your current password",
      "Your one-time code",
    ]);
    expect(fields.map((field) => field.required)).toEqual([true, false]);
  });
});

describe("loginSubtitle", () => {
  it("names the storage when an administrator named it", () => {
    expect(loginSubtitle(local)).toBe("Sign in with your fdrive account on files.example.org");
  });

  it("names the product alone without a name or without the list", () => {
    expect(loginSubtitle({ label: "" })).toBe("Sign in with your fdrive account");
    expect(loginSubtitle(undefined)).toBe("Sign in with your fdrive account");
  });
});

describe("buildCredential and credentialComplete", () => {
  const fields = local.credentialFields;

  it("keeps filled fields and drops blank optional ones", () => {
    expect(buildCredential(fields, { username: "ada", password: "pw", otp: "" })).toEqual({
      username: "ada",
      password: "pw",
    });
    expect(buildCredential(fields, { username: "ada", password: "pw", otp: "123" })).toEqual({
      username: "ada",
      password: "pw",
      otp: "123",
    });
  });

  it("keeps a blank required field so the server reports it", () => {
    expect(buildCredential(fields, { username: "ada" })).toEqual({ username: "ada", password: "" });
  });

  it("is complete once every required field is filled", () => {
    expect(credentialComplete(fields, { username: "ada" })).toBe(false);
    expect(credentialComplete(fields, { username: "ada", password: "pw" })).toBe(true);
    expect(credentialComplete([], {})).toBe(true);
  });
});
