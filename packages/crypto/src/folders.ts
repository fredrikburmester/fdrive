import { EncryptedFolderMarker } from "@fdrive/contracts";
import { base64 } from "@scure/base";
import { DecryptError, newKeyPair, openWithIdentity, recipientOf, sealToRecipient } from "./age.ts";
import { identityScalar, nameKey } from "./names.ts";

/** What opens an encrypted folder: its id, identity and recipient, and its name key. */
export interface FolderKey {
  readonly id: string;
  readonly identity: string;
  readonly recipient: string;
  readonly nameKey: CryptoKey;
}

const MARKER_MAC_INFO = new Uint8Array(new TextEncoder().encode("fdrive/marker-mac/v1"));

/** The HMAC-SHA-256 key an account authenticates its markers with, from its identity. */
async function markerMacKey(accountIdentity: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    identityScalar(accountIdentity),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: MARKER_MAC_INFO },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

/**
 * What a marker's MAC covers: its fields as a JSON array, `[v, id, recipient, [[recipient,
 * key], …]]`. None of the values need escaping, so every implementation writes the same bytes.
 */
export function markerMacInput(
  marker: Omit<EncryptedFolderMarker, "mac">,
): Uint8Array<ArrayBuffer> {
  const fields = [
    marker.v,
    marker.id,
    marker.recipient,
    marker.members.map((member) => [member.recipient, member.key]),
  ];
  return new Uint8Array(new TextEncoder().encode(JSON.stringify(fields)));
}

/** Adds the MAC an account authenticates a marker with. */
export async function signMarker(
  unsigned: Omit<EncryptedFolderMarker, "mac">,
  accountIdentity: string,
): Promise<EncryptedFolderMarker> {
  const mac = await crypto.subtle.sign(
    "HMAC",
    await markerMacKey(accountIdentity),
    markerMacInput(unsigned),
  );
  return { ...unsigned, mac: base64.encode(new Uint8Array(mac)) };
}

/** A new encrypted folder's marker and key, for the account whose identity is given. */
export async function createFolder(
  accountIdentity: string,
): Promise<{ marker: EncryptedFolderMarker; folder: FolderKey }> {
  const accountRecipient = await recipientOf(accountIdentity);
  const pair = await newKeyPair();
  const id = crypto.randomUUID();
  const unsigned = {
    v: 1 as const,
    id,
    recipient: pair.recipient,
    members: [
      { recipient: accountRecipient, key: await sealToRecipient(pair.identity, accountRecipient) },
    ],
  };
  return {
    marker: await signMarker(unsigned, accountIdentity),
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

/**
 * Opens an encrypted folder with its owner's account identity. The marker's MAC is checked
 * first: a marker the server made, even one wrapped to the owner's public recipient, fails.
 */
export async function openFolder(
  marker: EncryptedFolderMarker,
  accountIdentity: string,
): Promise<FolderKey> {
  const authentic = await crypto.subtle.verify(
    "HMAC",
    await markerMacKey(accountIdentity),
    new Uint8Array(base64.decode(marker.mac)),
    markerMacInput(marker),
  );
  if (!authentic) throw new DecryptError("this folder's marker was not made with your key");
  const accountRecipient = await recipientOf(accountIdentity);
  const member = marker.members.find((candidate) => candidate.recipient === accountRecipient);
  if (member === undefined) throw new DecryptError("this folder is not encrypted for you");
  const identity = await openWithIdentity(member.key, accountIdentity);
  if ((await recipientOf(identity)) !== marker.recipient) {
    throw new DecryptError("the folder's key does not match its recipient");
  }
  return { id: marker.id, identity, recipient: marker.recipient, nameKey: await nameKey(identity) };
}
