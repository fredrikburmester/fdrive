import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { chmod, chown, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** SSH strings and positive mpints use a four-byte, big-endian length. */
export function sshField(bytes: Buffer, integer = false): Buffer {
  const value =
    integer && (bytes[0] ?? 0) >= 128 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length);
  return Buffer.concat([length, value]);
}

export function publicProofKey(privatePem: string): string {
  const key = createPrivateKey(privatePem);
  if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
    throw new Error("Office proof key must be RSA with at least 2048 bits");
  }
  const { n, e } = createPublicKey(key).export({ format: "jwk" });
  return publicSshKey(n, e);
}

export function publicSshKey(n: string | undefined, e: string | undefined): string {
  if (!n || !e) throw new Error("Invalid RSA public key");
  return `ssh-rsa ${Buffer.concat([
    sshField(Buffer.from("ssh-rsa")),
    sshField(Buffer.from(e, "base64url"), true),
    sshField(Buffer.from(n, "base64url"), true),
  ]).toString("base64")} fdrive-office\n`;
}

export function generatePrivateProofKey(): string {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
}

async function optionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Never replace a private key, including when an earlier initialization was interrupted. */
export async function initializeProofKeys(
  directory: string,
  owner?: { uid: number; gid: number },
): Promise<boolean> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const privatePath = join(directory, "proof_key");
  const publicPath = `${privatePath}.pub`;
  const existingPrivate = await optionalFile(privatePath);
  const existingPublic = await optionalFile(publicPath);
  if (!existingPrivate && existingPublic)
    throw new Error("Public proof key exists without private key");
  const privateKey = existingPrivate ?? generatePrivateProofKey();
  const publicKey = publicProofKey(privateKey);
  if (existingPublic !== undefined && existingPublic !== publicKey) {
    throw new Error("Existing public proof key does not match private key");
  }
  if (existingPrivate === undefined)
    await writeFile(privatePath, privateKey, { flag: "wx", mode: 0o600 });
  if (existingPublic === undefined)
    await writeFile(publicPath, publicKey, { flag: "wx", mode: 0o600 });
  for (const path of [directory, privatePath, publicPath]) {
    await chmod(path, path === directory ? 0o700 : 0o600);
    if (owner !== undefined) await chown(path, owner.uid, owner.gid);
  }
  return existingPrivate === undefined;
}
