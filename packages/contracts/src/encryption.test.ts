import { describe, expect, it } from "vitest";
import {
  AgeFileBase64,
  AgeRecipient,
  EncryptedFolderMarker,
  isEncryptedName,
} from "./encryption.ts";

const RECIPIENT = `age1${"q".repeat(58)}`;

describe("encrypted names", () => {
  it("accept the shape of an encrypted name", () => {
    // 29 bytes: 47 characters.
    expect(isEncryptedName(`fe1-${"a".repeat(47)}`)).toBe(true);
    // 156 bytes, the longest: 250 characters.
    expect(isEncryptedName(`fe1-${"a".repeat(250)}`)).toBe(true);
  });

  it("refuse clear names, other prefixes, case and impossible lengths", () => {
    expect(isEncryptedName("photo.jpg")).toBe(false);
    expect(isEncryptedName(`fe2-${"a".repeat(47)}`)).toBe(false);
    expect(isEncryptedName(`fe1-${"A".repeat(47)}`)).toBe(false);
    expect(isEncryptedName(`fe1-${"a".repeat(46)}`)).toBe(false);
    expect(isEncryptedName(`fe1-${"a".repeat(251)}`)).toBe(false);
    // 49 characters is no whole number of bytes.
    expect(isEncryptedName(`fe1-${"a".repeat(49)}`)).toBe(false);
  });
});

describe("marker", () => {
  const marker = {
    v: 1,
    id: "2f1b8f3e-8c55-4d2b-9a57-1d3b6f0c2a11",
    recipient: RECIPIENT,
    members: [{ recipient: RECIPIENT, key: "YWdl" }],
    mac: `${"A".repeat(43)}=`,
  };

  it("parses version 1 with one member", () => {
    expect(EncryptedFolderMarker.parse(marker)).toEqual(marker);
  });

  it("refuses other versions, recipients and member counts", () => {
    expect(EncryptedFolderMarker.safeParse({ ...marker, v: 2 }).success).toBe(false);
    expect(EncryptedFolderMarker.safeParse({ ...marker, members: [] }).success).toBe(false);
    expect(EncryptedFolderMarker.safeParse({ ...marker, mac: "short" }).success).toBe(false);
    expect(AgeRecipient.safeParse("age1b").success).toBe(false);
    expect(AgeFileBase64.safeParse("not base64!").success).toBe(false);
  });
});
