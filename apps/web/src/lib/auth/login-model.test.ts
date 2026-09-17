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
  providerDisplayName,
  selectProvider,
} from "./login-model";

const sftpgo: PublicProvider = {
  id: "00000000-0000-4000-8000-000000000001",
  type: "sftpgo",
  label: "files.example.org",
  credentialFields: [
    { name: "username", label: "User", kind: "text", required: true },
    { name: "password", label: "Password", kind: "password", required: true },
    { name: "otp", label: "Code", kind: "otp", required: false, transient: true },
  ],
  capabilities: allCapabilities(true),
};
const second: PublicProvider = { ...sftpgo, id: "00000000-0000-4000-8000-000000000002" };

describe("credentialFieldsFor", () => {
  it("uses the provider's fields, else the SFTPGo-shaped defaults", () => {
    expect(credentialFieldsFor(sftpgo)).toBe(sftpgo.credentialFields);
    expect(credentialFieldsFor(undefined)).toBe(DEFAULT_CREDENTIAL_FIELDS);
  });
});

describe("confirmationFieldsFor", () => {
  it("keeps only the secret fields and relabels them as the current login's", () => {
    const fields = confirmationFieldsFor(sftpgo.credentialFields);
    expect(fields.map((field) => field.name)).toEqual(["password", "otp"]);
    expect(fields.map((field) => field.label)).toEqual([
      "Your current password",
      "Your one-time code",
    ]);
    expect(fields.map((field) => field.required)).toEqual([true, false]);
  });
});

describe("loginSubtitle", () => {
  it("names the one provider, asks to choose among several, and stays generic without any", () => {
    expect(loginSubtitle([sftpgo])).toBe("Sign in with your SFTPGo account on files.example.org");
    expect(loginSubtitle([{ ...sftpgo, label: "" }])).toBe("Sign in with your SFTPGo account");
    expect(loginSubtitle([sftpgo, second])).toBe("Choose a server and sign in");
    expect(loginSubtitle([])).toBe("Sign in with your account");
  });
});

describe("providerDisplayName", () => {
  it("uses the admin's label and falls back to the product name", () => {
    expect(providerDisplayName(sftpgo)).toBe("files.example.org");
    expect(providerDisplayName({ type: "sftpgo", label: "" })).toBe("SFTPGo");
  });
});

describe("buildCredential and credentialComplete", () => {
  const fields = sftpgo.credentialFields;

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

describe("selectProvider", () => {
  it("finds the named provider, else the first, else nothing", () => {
    expect(selectProvider([sftpgo, second], second.id)).toBe(second);
    expect(selectProvider([sftpgo, second], "missing")).toBe(sftpgo);
    expect(selectProvider([sftpgo, second], null)).toBe(sftpgo);
    expect(selectProvider([], null)).toBeUndefined();
  });
});
