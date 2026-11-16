import { EncryptedFolderMarker } from "@fdrive/contracts";
import { DecryptError, newKeyPair, openWithIdentity, recipientOf, sealToRecipient } from "./age.ts";
import { nameKey } from "./names.ts";

/** What opens an encrypted folder: its id, identity and recipient, and its name key. */
export interface FolderKey {
  readonly id: string;
  readonly identity: string;
  readonly recipient: string;
  readonly nameKey: CryptoKey;
}

/** A new encrypted folder's marker and key, for the account whose recipient is given. */
export async function createFolder(
  accountRecipient: string,
): Promise<{ marker: EncryptedFolderMarker; folder: FolderKey }> {
  const pair = await newKeyPair();
  const id = crypto.randomUUID();
  const marker: EncryptedFolderMarker = {
    v: 1,
    id,
    recipient: pair.recipient,
    members: [
      { recipient: accountRecipient, key: await sealToRecipient(pair.identity, accountRecipient) },
    ],
  };
  return {
    marker,
    folder: {
      id,
      identity: pair.identity,
      recipient: pair.recipient,
      nameKey: await nameKey(pair.identity),
    },
  };
}

/** Parses a marker file's text; throws a {@link DecryptError} when it is not one. */
export function parseMarker(text: string): EncryptedFolderMarker {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new DecryptError("the folder's marker is not JSON");
  }
  const parsed = EncryptedFolderMarker.safeParse(json);
  if (!parsed.success) throw new DecryptError("the folder's marker is not one fdrive reads");
  return parsed.data;
}

/** Opens an encrypted folder with the account identity of one of its members. */
export async function openFolder(
  marker: EncryptedFolderMarker,
  accountIdentity: string,
): Promise<FolderKey> {
  const accountRecipient = await recipientOf(accountIdentity);
  const member = marker.members.find((candidate) => candidate.recipient === accountRecipient);
  if (member === undefined) throw new DecryptError("this folder is not encrypted for you");
  const identity = await openWithIdentity(member.key, accountIdentity);
  if ((await recipientOf(identity)) !== marker.recipient) {
    throw new DecryptError("the folder's key does not match its recipient");
  }
  return { id: marker.id, identity, recipient: marker.recipient, nameKey: await nameKey(identity) };
}
