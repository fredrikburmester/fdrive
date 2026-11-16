import { z } from "zod";

/**
 * End-to-end encrypted folders. Keys are age identities made and opened on the person's
 * devices; the server keeps only public recipients and age files it cannot open. See
 * docs/ENCRYPTION.md.
 */

/** The file at the top of an encrypted folder that holds its keys. Hidden from every listing. */
export const ENCRYPTED_FOLDER_MARKER = ".fdrive-encrypted";

/** What every encrypted name on disk starts with: the format's version. */
export const ENCRYPTED_NAME_PREFIX = "fe1-";

/** The longest name, in UTF-8 bytes after NFC, whose encrypted form still fits a file name. */
export const MAX_ENCRYPTED_NAME_BYTES = 128;

/** What every age file starts with, in bytes as ASCII. */
export const AGE_HEADER_PREFIX = "age-encryption.org/v1\n";

/** Shortest encrypted name: a 12-byte nonce, a 16-byte tag and one byte of name, in base32. */
const MIN_ENCRYPTED_NAME_CHARS = Math.ceil(((12 + 16 + 1) * 8) / 5);
/** Longest: the 128-byte name limit. */
const MAX_ENCRYPTED_NAME_CHARS = Math.ceil(((12 + 16 + MAX_ENCRYPTED_NAME_BYTES) * 8) / 5);
const ENCRYPTED_NAME_PATTERN = new RegExp(
  `^${ENCRYPTED_NAME_PREFIX}[a-z2-7]{${MIN_ENCRYPTED_NAME_CHARS},${MAX_ENCRYPTED_NAME_CHARS}}$`,
);

/** Valid base32 lengths leave fewer than five spare bits, all of them zero. */
const BASE32_LENGTH_REMAINDERS = new Set([0, 2, 4, 5, 7]);

/**
 * Whether a stored name has the shape of an encrypted name. The server checks every name it
 * writes inside an encrypted folder with this, so a confused client cannot store a clear one.
 * It cannot tell whether the name decrypts.
 */
export function isEncryptedName(name: string): boolean {
  if (!ENCRYPTED_NAME_PATTERN.test(name)) return false;
  const body = name.length - ENCRYPTED_NAME_PREFIX.length;
  return BASE32_LENGTH_REMAINDERS.has(body % 8);
}

/** Whether any segment of `path` is an encrypted name: a path inside an encrypted folder. */
export function hasEncryptedName(path: string): boolean {
  return path.split("/").some(isEncryptedName);
}

/** An age X25519 recipient, `age1` and 58 bech32 characters. */
export const AgeRecipient = z.string().regex(/^age1[02-9ac-hj-np-z]{58}$/, "not an age recipient");
export type AgeRecipient = z.infer<typeof AgeRecipient>;

/** An age file, base64. Small: it carries a key, not a document. */
export const AgeFileBase64 = z
  .string()
  .min(1)
  .max(16_384)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, "not base64");
export type AgeFileBase64 = z.infer<typeof AgeFileBase64>;

/** One person who can open an encrypted folder: their account recipient and the folder key for them. */
export const EncryptedFolderMember = z.object({
  recipient: AgeRecipient,
  /** The folder identity as an age file to the member's recipient. */
  key: AgeFileBase64,
});
export type EncryptedFolderMember = z.infer<typeof EncryptedFolderMember>;

/** The contents of `.fdrive-encrypted`, JSON. Version 1 has exactly one member, its owner. */
export const EncryptedFolderMarker = z.object({
  v: z.literal(1),
  id: z.uuid(),
  /** The folder's recipient: every file inside is an age file to it. */
  recipient: AgeRecipient,
  members: z.array(EncryptedFolderMember).length(1),
  /**
   * HMAC-SHA-256 over the fields above, keyed from the owner's account identity, base64. The
   * server cannot make one, so it cannot swap in a folder key of its own.
   */
  mac: z.string().regex(/^[A-Za-z0-9+/]{43}=$/, "not a MAC"),
});
export type EncryptedFolderMarker = z.infer<typeof EncryptedFolderMarker>;

/** The sign-in password, asked again before encryption keys change. */
const SignInPassword = z.string().min(1).max(1024);

/** A paired Mac that holds a copy of the account key. */
export const EncryptionDevice = z.object({
  /** The Mac's desktop token. */
  id: z.uuid(),
  name: z.string(),
  createdAt: z.iso.datetime(),
});
export type EncryptionDevice = z.infer<typeof EncryptionDevice>;

/** `GET /encryption`: whether the signed-in person turned encryption on, and their key copies. */
export const EncryptionStatus = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }),
  z.object({
    enabled: z.literal(true),
    recipient: AgeRecipient,
    /** The account identity as an age file to the encryption password. */
    passwordKey: AgeFileBase64,
    /** The account identity as an age file to the recovery key. */
    recoveryKey: AgeFileBase64,
    devices: z.array(EncryptionDevice),
    createdAt: z.iso.datetime(),
  }),
]);
export type EncryptionStatus = z.infer<typeof EncryptionStatus>;

/** `POST /encryption`: turn encryption on with keys the browser made. */
export const EncryptionSetupRequest = z.strictObject({
  signInPassword: SignInPassword,
  recipient: AgeRecipient,
  passwordKey: AgeFileBase64,
  recoveryKey: AgeFileBase64,
});
export type EncryptionSetupRequest = z.infer<typeof EncryptionSetupRequest>;

/** `PUT /encryption/password`: a new encryption password's copy of the same account key. */
export const EncryptionPasswordRequest = z.strictObject({
  signInPassword: SignInPassword,
  passwordKey: AgeFileBase64,
});
export type EncryptionPasswordRequest = z.infer<typeof EncryptionPasswordRequest>;

/** `POST /encryption/reset`: delete every key copy. Encrypted folders stay, unreadable. */
export const EncryptionResetRequest = z.strictObject({ signInPassword: SignInPassword });
export type EncryptionResetRequest = z.infer<typeof EncryptionResetRequest>;

/** An encrypted folder: its path and its marker. */
export const EncryptedFolderInfo = z.object({
  path: z.string(),
  marker: EncryptedFolderMarker,
});
export type EncryptedFolderInfo = z.infer<typeof EncryptedFolderInfo>;

/** `POST /encryption/folders`: make a new encrypted folder with a marker the browser made. */
export const EncryptedFolderCreateRequest = z.strictObject({
  path: z.string().min(2),
  marker: EncryptedFolderMarker,
});
export type EncryptedFolderCreateRequest = z.infer<typeof EncryptedFolderCreateRequest>;

/** `GET /encryption/folder?path=`: the encrypted folder a path is or is inside; null when none. */
export const EncryptedFolderResponse = z.object({ folder: EncryptedFolderInfo.nullable() });
export type EncryptedFolderResponse = z.infer<typeof EncryptedFolderResponse>;

/** `GET /encryption/entries?path=`: the entries inside an encrypted folder, for name search. */
export const EncryptedEntriesQuery = z.object({ path: z.string() });
export type EncryptedEntriesQuery = z.infer<typeof EncryptedEntriesQuery>;

export const EncryptedEntry = z.object({
  path: z.string(),
  kind: z.enum(["file", "dir"]),
});
export type EncryptedEntry = z.infer<typeof EncryptedEntry>;

/** The most entries one answer holds. */
export const MAX_ENCRYPTED_ENTRIES = 20_000;

export const EncryptedEntriesResponse = z.object({
  entries: z.array(EncryptedEntry),
  /** More entries than {@link MAX_ENCRYPTED_ENTRIES} were found; the rest were left out. */
  truncated: z.boolean(),
});
export type EncryptedEntriesResponse = z.infer<typeof EncryptedEntriesResponse>;

/**
 * Sent with value `1` by clients that encrypt and decrypt: FDrive for Mac on every desktop
 * request. Without it, the desktop API treats encrypted folders as folders it cannot open, as
 * older apps expect.
 */
export const ENCRYPTED_FOLDERS_HEADER = "x-fdrive-encrypted-folders";

/** `GET /api/v2/desktop/encryption`: this Mac's copy of the account key. */
export const DesktopEncryptionKey = z.object({
  recipient: AgeRecipient,
  /** The account identity as an age file to the Mac's device recipient. */
  deviceKey: AgeFileBase64,
});
export type DesktopEncryptionKey = z.infer<typeof DesktopEncryptionKey>;

/** The `details.code` of a refusal because a path is inside an encrypted folder. */
export const ENCRYPTED_FOLDER_REFUSAL = "encrypted_folder";
