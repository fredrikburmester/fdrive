import { describe, expect, it } from "vitest";
import {
  createAccountKeys,
  deviceKeyFor,
  keyFingerprint,
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

describe("key codes", () => {
  it("give an account key 64 bits of its recipient's SHA-256", async () => {
    // SHA-256("abc") starts ba7816bf8f01cfea.
    expect(await keyFingerprint("abc")).toBe("BA78-16BF-8F01-CFEA");
  });

  it("cover the device recipient and the pairing's nonce", async () => {
    // SHA-256("a\nbc") is not SHA-256("ab\nc"), and neither is the recipient alone.
    expect(await pairingCode("a", "bc")).not.toBe(await pairingCode("ab", "c"));
    expect(await pairingCode("a", "bc")).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
    expect(await pairingCode("a", "bc")).toBe(await pairingCode("a", "bc"));
  });
});
