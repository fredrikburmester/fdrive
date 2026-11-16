import { EncryptedFolderMarker } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import { DecryptError, newKeyPair, sealToRecipient } from "./age.ts";
import { createFolder, openFolder, parseMarker } from "./folders.ts";
import { decryptName, encryptName } from "./names.ts";

describe("encrypted folders", () => {
  it("makes a marker its owner opens to the same keys", async () => {
    const account = await newKeyPair();
    const { marker, folder } = await createFolder(account.recipient);
    expect(EncryptedFolderMarker.parse(marker)).toEqual(marker);
    const opened = await openFolder(parseMarker(JSON.stringify(marker)), account.identity);
    expect(opened.id).toBe(folder.id);
    expect(opened.identity).toBe(folder.identity);
    expect(opened.recipient).toBe(marker.recipient);
    const stored = await encryptName("a.txt", folder.nameKey, folder.id);
    expect(await decryptName(stored, opened.nameKey, opened.id)).toBe("a.txt");
  });

  it("refuses an account that is not a member", async () => {
    const { marker } = await createFolder((await newKeyPair()).recipient);
    await expect(openFolder(marker, (await newKeyPair()).identity)).rejects.toBeInstanceOf(
      DecryptError,
    );
  });

  it("refuses a member key that opens to another folder's identity", async () => {
    const account = await newKeyPair();
    const { marker } = await createFolder(account.recipient);
    const swapped = (await newKeyPair()).identity;
    const forged = {
      ...marker,
      members: [
        { recipient: account.recipient, key: await sealToRecipient(swapped, account.recipient) },
      ],
    };
    await expect(openFolder(forged, account.identity)).rejects.toBeInstanceOf(DecryptError);
  });

  it("refuses marker text that is not a marker", () => {
    expect(() => parseMarker("{")).toThrow(DecryptError);
    expect(() => parseMarker(JSON.stringify({ v: 2 }))).toThrow(DecryptError);
  });
});
