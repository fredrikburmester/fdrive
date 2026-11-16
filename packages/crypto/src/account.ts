import {
  DEFAULT_SCRYPT_WORK_FACTOR,
  DecryptError,
  newKeyPair,
  openWithIdentity,
  openWithPassword,
  recipientOf,
  sealToRecipient,
  sealWithPassword,
} from "./age.ts";

/**
 * A person's encryption keys as turning encryption on makes them. The server keeps
 * `recipient`, `passwordKey` and `recoveryKey`; `recoveryIdentity` is what they save.
 */
export interface NewAccountKeys {
  readonly identity: string;
  readonly recipient: string;
  readonly recoveryIdentity: string;
  /** The account identity as an age file to the encryption password, base64. */
  readonly passwordKey: string;
  /** The account identity as an age file to the recovery key, base64. */
  readonly recoveryKey: string;
}

export interface PasswordOptions {
  /** The scrypt work factor; age's default unless a test lowers it. */
  readonly workFactor?: number;
}

/** The shortest encryption password accepted. */
export const MIN_ENCRYPTION_PASSWORD_LENGTH = 12;

export async function createAccountKeys(
  password: string,
  options: PasswordOptions = {},
): Promise<NewAccountKeys> {
  const account = await newKeyPair();
  const recovery = await newKeyPair();
  return {
    identity: account.identity,
    recipient: account.recipient,
    recoveryIdentity: recovery.identity,
    passwordKey: await passwordKeyFor(account.identity, password, options),
    recoveryKey: await sealToRecipient(account.identity, recovery.recipient),
  };
}

/** The account identity as an age file to a (new) encryption password. */
export async function passwordKeyFor(
  identity: string,
  password: string,
  options: PasswordOptions = {},
): Promise<string> {
  return sealWithPassword(identity, password, options.workFactor ?? DEFAULT_SCRYPT_WORK_FACTOR);
}

/** The account identity as an age file to a paired Mac's device recipient. */
export async function deviceKeyFor(identity: string, deviceRecipient: string): Promise<string> {
  return sealToRecipient(identity, deviceRecipient);
}

async function checked(identity: string, recipient: string): Promise<string> {
  if ((await recipientOf(identity)) !== recipient) {
    throw new DecryptError("the key does not belong to this account");
  }
  return identity;
}

/** The account identity from the encryption password; a wrong password is a {@link DecryptError}. */
export async function unlockWithPassword(
  passwordKey: string,
  password: string,
  recipient: string,
): Promise<string> {
  return checked(await openWithPassword(passwordKey, password), recipient);
}

/** The account identity from the saved recovery key. */
export async function unlockWithRecovery(
  recoveryKey: string,
  recoveryIdentity: string,
  recipient: string,
): Promise<string> {
  return checked(await openWithIdentity(recoveryKey, recoveryIdentity.trim()), recipient);
}

/** The account identity from a Mac's own device identity. */
export async function unlockWithDevice(
  deviceKey: string,
  deviceIdentity: string,
  recipient: string,
): Promise<string> {
  return checked(await openWithIdentity(deviceKey, deviceIdentity), recipient);
}

/**
 * 64 bits of a recipient's SHA-256 in uppercase hex, in four groups of four: long enough that
 * nobody can make another key with the same code.
 */
async function keyCode(recipient: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(recipient));
  const hex = Array.from(new Uint8Array(digest).subarray(0, 8), (byte) =>
    byte.toString(16).padStart(2, "0"),
  )
    .join("")
    .toUpperCase();
  return [hex.slice(0, 4), hex.slice(4, 8), hex.slice(8, 12), hex.slice(12)].join("-");
}

/**
 * The code a person compares when pairing a Mac: from the Mac's device recipient and the
 * pairing's random nonce, which the server picks per pairing so nobody can copy a Mac's code
 * into a request of their own. The browser computes it from the recipient it encrypts to, so a
 * recipient the server swapped in shows a different code.
 */
export async function pairingCode(deviceRecipient: string, nonce: string): Promise<string> {
  return keyCode(`${deviceRecipient}\n${nonce}`);
}

/**
 * The fingerprint Account > Encryption and the Mac app show for an account key, so a person
 * can see that their Mac holds the same key as their browser.
 */
export async function keyFingerprint(accountRecipient: string): Promise<string> {
  return keyCode(accountRecipient);
}
