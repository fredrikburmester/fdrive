import { describe, expect, it } from "vitest";
import {
  createAccountKeys,
  deviceKeyFor,
  pairingCode,
  passwordKeyFor,
  unlockWithDevice,
  unlockWithPassword,
  unlockWithRecovery,
} from "./account.ts";
import { DecryptError, newKeyPair, recipientOf } from "./age.ts";

const FAST = { workFactor: 10 };

describe("account keys", () => {
  it("unlock with the encryption password or the recovery key", async () => {
    const keys = await createAccountKeys("a long password", FAST);
    expect(await recipientOf(keys.identity)).toBe(keys.recipient);
    expect(await unlockWithPassword(keys.passwordKey, "a long password", keys.recipient)).toBe(
      keys.identity,
    );
    expect(
      await unlockWithRecovery(keys.recoveryKey, `  ${keys.recoveryIdentity}\n`, keys.recipient),
    ).toBe(keys.identity);
  });

  it("refuse a wrong password", async () => {
    const keys = await createAccountKeys("a long password", FAST);
    await expect(unlockWithPassword(keys.passwordKey, "wrong", keys.recipient)).rejects.toThrow(
      DecryptError,
    );
  });

  it("refuse a copy that holds another account's identity", async () => {
    const keys = await createAccountKeys("a long password", FAST);
    const other = await newKeyPair();
    const forged = await passwordKeyFor(other.identity, "a long password", FAST);
    await expect(unlockWithPassword(forged, "a long password", keys.recipient)).rejects.toThrow(
      DecryptError,
    );
  });

  it("change the encryption password by sealing the identity again", async () => {
    const keys = await createAccountKeys("a long password", FAST);
    const next = await passwordKeyFor(keys.identity, "another long one", FAST);
    expect(await unlockWithPassword(next, "another long one", keys.recipient)).toBe(keys.identity);
  });

  it("reach a Mac through its device key", async () => {
    const keys = await createAccountKeys("a long password", FAST);
    const device = await newKeyPair();
    const deviceKey = await deviceKeyFor(keys.identity, device.recipient);
    expect(await unlockWithDevice(deviceKey, device.identity, keys.recipient)).toBe(keys.identity);
  });

  it("use the default work factor when none is given", async () => {
    const pair = await newKeyPair();
    const sealed = await passwordKeyFor(pair.identity, "a long password");
    expect(await unlockWithPassword(sealed, "a long password", pair.recipient)).toBe(pair.identity);
  }, 30_000);
});

describe("pairing code", () => {
  it("is the first four bytes of the recipient's SHA-256 in uppercase hex", async () => {
    // SHA-256("abc") starts ba7816bf.
    expect(await pairingCode("abc")).toBe("BA7816BF");
  });
});
