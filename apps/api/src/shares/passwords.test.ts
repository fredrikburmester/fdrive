import { describe, expect, it } from "vitest";
import { createScryptSharePasswords } from "./passwords.ts";

// Cheap parameters: the scheme is what is under test, not its cost.
const passwords = createScryptSharePasswords({ cost: 1024, blockSize: 8, parallelization: 1 });

describe("share passwords", () => {
  it("hashes with a fresh salt and verifies only the right password", async () => {
    const one = await passwords.hash("secret");
    const two = await passwords.hash("secret");
    expect(one).not.toBe(two);
    expect(one.startsWith("scrypt$1024$8$1$")).toBe(true);
    expect(one).not.toContain("secret");
    expect(await passwords.verify("secret", one)).toBe(true);
    expect(await passwords.verify("secret", two)).toBe(true);
    expect(await passwords.verify("Secret", one)).toBe(false);
    expect(await passwords.verify("", one)).toBe(false);
  });

  it("reads the parameters off the hash, so a stronger default keeps old hashes valid", async () => {
    const cheap = await passwords.hash("pw");
    const stronger = createScryptSharePasswords({ cost: 2048, blockSize: 8, parallelization: 1 });
    expect(await stronger.verify("pw", cheap)).toBe(true);
    expect((await stronger.hash("pw")).startsWith("scrypt$2048$")).toBe(true);
  });

  it("refuses a missing or unreadable hash without throwing", async () => {
    const hash = await passwords.hash("pw");
    for (const bad of [
      null,
      "",
      "plain",
      "bcrypt$2b$10$abc",
      "scrypt$x$8$1$AA$AA",
      "scrypt$1$8$1$AA$AA",
      "scrypt$1024$0$1$AA$AA",
      "scrypt$1024$8$0$AA$AA",
      "scrypt$1024$8$1$$AA",
      "scrypt$1024$8$1$AA$short",
      `${hash}$extra`,
    ])
      expect(await passwords.verify("pw", bad)).toBe(false);
  });

  it("versions a hash without revealing it and names an open share", async () => {
    const hash = await passwords.hash("pw");
    const version = passwords.version(hash);
    expect(version).toHaveLength(22);
    expect(version).not.toContain("$");
    expect(hash).not.toContain(version);
    expect(passwords.version(hash)).toBe(version);
    expect(passwords.version(await passwords.hash("pw"))).not.toBe(version);
    expect(passwords.version(null)).toBe("open");
  });
});
