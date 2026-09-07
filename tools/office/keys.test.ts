import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  generatePrivateProofKey,
  initializeProofKeys,
  publicProofKey,
  publicSshKey,
  sshField,
} from "./keys.ts";

const directories: string[] = [];
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "fdrive-office-keys-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("proof key generation", () => {
  it("encodes SSH strings and positive integers including the high-bit prefix", () => {
    expect(sshField(Buffer.from([128]), true)).toEqual(Buffer.from([0, 0, 0, 2, 0, 128]));
    expect(sshField(Buffer.from([127]), true)).toEqual(Buffer.from([0, 0, 0, 1, 127]));
    expect(sshField(Buffer.from([128]))).toEqual(Buffer.from([0, 0, 0, 1, 128]));
    expect(sshField(Buffer.alloc(0), true)).toEqual(Buffer.alloc(4));
  });
  it("generates distinct RSA PEM keys with matching OpenSSH modulus and exponent", () => {
    const first = generatePrivateProofKey();
    const second = generatePrivateProofKey();
    expect(first).not.toBe(second);
    expect(first).toContain("BEGIN RSA PRIVATE KEY");
    const jwk = createPublicKey(createPrivateKey(first)).export({ format: "jwk" });
    const fields = publicProofKey(first).trim().split(" ");
    expect(fields[0]).toBe("ssh-rsa");
    expect(fields[2]).toBe("fdrive-office");
    const data = Buffer.from(fields[1] ?? "", "base64");
    let offset = 0;
    const values: Buffer[] = [];
    while (offset < data.length) {
      const length = data.readUInt32BE(offset);
      offset += 4;
      values.push(data.subarray(offset, offset + length));
      offset += length;
    }
    expect(values[0]?.toString()).toBe("ssh-rsa");
    expect(values[1]?.toString("base64url")).toBe(jwk.e);
    expect(values[2]?.subarray(1).toString("base64url")).toBe(jwk.n);
  });
  it("rejects incomplete RSA public components", () => {
    expect(() => publicSshKey(undefined, "AQAB")).toThrow("Invalid RSA");
    expect(() => publicSshKey("AQAB", undefined)).toThrow("Invalid RSA");
  });
  it("rejects non-RSA keys and short RSA keys", () => {
    for (const pem of [
      generateKeyPairSync("ed25519", {
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      }).privateKey,
      generateKeyPairSync("rsa", {
        modulusLength: 1024,
        privateKeyEncoding: { type: "pkcs1", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      }).privateKey,
    ])
      expect(() => publicProofKey(pem)).toThrow("at least 2048 bits");
    expect(() => publicProofKey("not a key")).toThrow();
  });
});

describe("private volume initialization", () => {
  it("creates private files, preserves keys on repeated runs and fixes permissions", async () => {
    const directory = join(await temporaryDirectory(), "keys");
    expect(
      await initializeProofKeys(directory, {
        uid: process.getuid?.() ?? 0,
        gid: process.getgid?.() ?? 0,
      }),
    ).toBe(true);
    const pem = await readFile(join(directory, "proof_key"), "utf8");
    expect(await readFile(join(directory, "proof_key.pub"), "utf8")).toBe(publicProofKey(pem));
    await chmod(join(directory, "proof_key"), 0o644);
    expect(await initializeProofKeys(directory)).toBe(false);
    expect(await readFile(join(directory, "proof_key"), "utf8")).toBe(pem);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, "proof_key"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, "proof_key.pub"))).mode & 0o777).toBe(0o600);
  });
  it("recovers an interrupted public-key write without rotating the private key", async () => {
    const directory = await temporaryDirectory();
    const pem = generatePrivateProofKey();
    await writeFile(join(directory, "proof_key"), pem);
    expect(await initializeProofKeys(directory)).toBe(false);
    expect(await readFile(join(directory, "proof_key.pub"), "utf8")).toBe(publicProofKey(pem));
  });
  it("refuses orphan public keys and mismatched key pairs", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "proof_key.pub"), "wrong key");
    await expect(initializeProofKeys(directory)).rejects.toThrow("without private key");
    await writeFile(join(directory, "proof_key"), generatePrivateProofKey());
    await expect(initializeProofKeys(directory)).rejects.toThrow("does not match");
  });
  it("propagates filesystem errors without regenerating keys", async () => {
    const directory = await temporaryDirectory();
    await mkdir(join(directory, "proof_key"));
    await expect(initializeProofKeys(directory)).rejects.toMatchObject({ code: "EISDIR" });
  });
});
