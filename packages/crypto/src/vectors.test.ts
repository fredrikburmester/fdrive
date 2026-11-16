import { existsSync, readFileSync } from "node:fs";
import { EncryptedFolderMarker } from "@fdrive/contracts";
import { base64 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { keyFingerprint, pairingCode, unlockWithDevice } from "./account.ts";
import { decryptStream, encryptedSize } from "./age.ts";
import { openFolder } from "./folders.ts";
import { decryptName, encryptName, nameKeyBytes } from "./names.ts";

/** The vectors the Swift implementation reproduces; regenerate with `pnpm vectors`. */
const vectors = JSON.parse(
  readFileSync(new URL("../vectors/v1.json", import.meta.url), "utf8"),
) as {
  age: { identity: string; files: { length: number; ciphertext: string; size: number }[] };
  folder: {
    accountIdentity: string;
    marker: unknown;
    identity: string;
    nameKey: string;
    names: { name: string; nonce: string; stored: string }[];
  };
  device: {
    identity: string;
    recipient: string;
    pairingCode: string;
    accountRecipient: string;
    accountFingerprint: string;
    deviceKey: string;
  };
};

/**
 * What FdriveKit made from the same keys: vectors/v1-swift.json, written by the Swift tests with
 * FDRIVE_WRITE_SWIFT_VECTORS=1. TS must open it, so the two implementations agree both ways.
 */
const swiftFile = new URL("../vectors/v1-swift.json", import.meta.url);
const swift = existsSync(swiftFile)
  ? (JSON.parse(readFileSync(swiftFile, "utf8")) as {
      ciphertext: string;
      length: number;
      names: { name: string; stored: string }[];
      marker: unknown;
      deviceKey: string;
    })
  : undefined;

function fromHex(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(text.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function decrypt(ciphertext: string, identity: string): Promise<Uint8Array> {
  const bytes = base64.decode(ciphertext);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Uint8Array(await new Response(await decryptStream(stream, identity)).arrayBuffer());
}

function pattern(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => index % 251);
}

describe("format v1 vectors", () => {
  it("decrypt to their plaintext at the predicted size", async () => {
    for (const file of vectors.age.files) {
      expect(base64.decode(file.ciphertext)).toHaveLength(file.size);
      expect(encryptedSize(file.length)).toBe(file.size);
      expect(await decrypt(file.ciphertext, vectors.age.identity)).toEqual(pattern(file.length));
    }
  });

  it("open the folder and reproduce its name key and names", async () => {
    const marker = EncryptedFolderMarker.parse(vectors.folder.marker);
    const folder = await openFolder(marker, vectors.folder.accountIdentity);
    expect(folder.identity).toBe(vectors.folder.identity);
    expect(hex(await nameKeyBytes(folder.identity))).toBe(vectors.folder.nameKey);
    for (const entry of vectors.folder.names) {
      expect(await encryptName(entry.name, folder.nameKey, folder.id, fromHex(entry.nonce))).toBe(
        entry.stored,
      );
      expect(await decryptName(entry.stored, folder.nameKey, folder.id)).toBe(
        entry.name.normalize("NFC"),
      );
    }
  });

  it("reach the account through the device key and show its pairing code", async () => {
    const { device } = vectors;
    expect(await pairingCode(device.recipient)).toBe(device.pairingCode);
    expect(await keyFingerprint(device.accountRecipient)).toBe(device.accountFingerprint);
    expect(await unlockWithDevice(device.deviceKey, device.identity, device.accountRecipient)).toBe(
      vectors.folder.accountIdentity,
    );
  });

  it.runIf(swift !== undefined)("decrypt what the Swift implementation made", async () => {
    if (swift === undefined) return;
    expect(await decrypt(swift.ciphertext, vectors.age.identity)).toEqual(pattern(swift.length));
    const marker = EncryptedFolderMarker.parse(vectors.folder.marker);
    const folder = await openFolder(marker, vectors.folder.accountIdentity);
    for (const entry of swift.names) {
      expect(await decryptName(entry.stored, folder.nameKey, folder.id)).toBe(entry.name);
    }
    // A folder FdriveKit made for the same account opens here, MAC and all.
    await openFolder(EncryptedFolderMarker.parse(swift.marker), vectors.folder.accountIdentity);
    const { device } = vectors;
    expect(await unlockWithDevice(swift.deviceKey, device.identity, device.accountRecipient)).toBe(
      vectors.folder.accountIdentity,
    );
  });
});
