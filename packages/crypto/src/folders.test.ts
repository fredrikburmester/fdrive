import { EncryptedFolderMarker } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import { DecryptError, newKeyPair, sealToRecipient } from "./age.ts";
import { createFolder, markerMacInput, openFolder, parseMarker, signMarker } from "./folders.ts";
import { decryptName, encryptName } from "./names.ts";

describe("encrypted folders", () => {
  it("makes a marker its owner opens to the same keys", async () => {
    const account = await newKeyPair();
    const { marker, folder } = await createFolder(account.identity);
    expect(EncryptedFolderMarker.parse(marker)).toEqual(marker);
    expect(marker.members[0]?.recipient).toBe(account.recipient);
    const opened = await openFolder(parseMarker(JSON.stringify(marker)), account.identity);
    expect(opened.id).toBe(folder.id);
    expect(opened.identity).toBe(folder.identity);
    expect(opened.recipient).toBe(marker.recipient);
    const stored = await encryptName("a.txt", folder.nameKey, folder.id);
    expect(await decryptName(stored, opened.nameKey, opened.id)).toBe("a.txt");
  });

  it("refuses a marker the server made for the owner's public recipient", async () => {
    const account = await newKeyPair();
    const { marker } = await createFolder(account.identity);
    // Without the owner's identity, a new folder key wrapped to their recipient keeps the old MAC.
    const server = await newKeyPair();
    const forged = {
      ...marker,
      recipient: server.recipient,
      members: [
        {
          recipient: account.recipient,
          key: await sealToRecipient(server.identity, account.recipient),
        },
      ],
    };
    await expect(openFolder(forged, account.identity)).rejects.toThrow("not made with your key");
  });

  it("refuses an account whose key did not make the marker", async () => {
    const { marker } = await createFolder((await newKeyPair()).identity);
    await expect(openFolder(marker, (await newKeyPair()).identity)).rejects.toBeInstanceOf(
      DecryptError,
    );
  });

  it("refuses a signed marker that is not encrypted for the account", async () => {
    const account = await newKeyPair();
    const other = await newKeyPair();
    const { marker } = await createFolder(other.identity);
    const { mac: _mac, ...unsigned } = marker;
    const signed = await signMarker(unsigned, account.identity);
    await expect(openFolder(signed, account.identity)).rejects.toThrow("not encrypted for you");
  });

  it("refuses a signed marker whose member key opens to another identity", async () => {
    const account = await newKeyPair();
    const { marker } = await createFolder(account.identity);
    const swapped = (await newKeyPair()).identity;
    const signed = await signMarker(
      {
        v: 1,
        id: marker.id,
        recipient: marker.recipient,
        members: [
          { recipient: account.recipient, key: await sealToRecipient(swapped, account.recipient) },
        ],
      },
      account.identity,
    );
    await expect(openFolder(signed, account.identity)).rejects.toThrow("does not match");
  });

  it("covers its fields with the MAC as a JSON array", () => {
    const input = markerMacInput({
      v: 1,
      id: "2f1b8f3e-8c55-4d2b-9a57-1d3b6f0c2a11",
      recipient: "age1r",
      members: [{ recipient: "age1m", key: "a2V5" }],
    });
    expect(new TextDecoder().decode(input)).toBe(
      '[1,"2f1b8f3e-8c55-4d2b-9a57-1d3b6f0c2a11","age1r",[["age1m","a2V5"]]]',
    );
  });

  it("refuses a MAC that is not base64", async () => {
    const account = await newKeyPair();
    const { marker } = await createFolder(account.identity);
    await expect(
      openFolder({ ...marker, mac: `${"B".repeat(43)}=` }, account.identity),
    ).rejects.toThrow("damaged");
  });

  it("refuses marker text that is not a marker", () => {
    expect(() => parseMarker("{")).toThrow(DecryptError);
    expect(() => parseMarker(JSON.stringify({ v: 2 }))).toThrow(DecryptError);
  });
});
