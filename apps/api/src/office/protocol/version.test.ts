import { expect, it } from "vitest";
import { deriveFileVersion } from "./version.ts";

it("retains nanosecond precision and optional normalized hash prefix", () => {
  expect(deriveFileVersion({ mtimeNs: 1788652800123456789n, size: 999n })).toBe(
    "1788652800123456789:999",
  );
  expect(deriveFileVersion({ mtimeNs: 1n, size: 0n, sha256: "AB".repeat(32) })).toBe(
    "1:0:abababababababab",
  );
  expect(deriveFileVersion({ mtimeNs: -1n, size: 0n })).toBe("-1:0");
});
it("changes with any version input", () => {
  const inputs = [
    { mtimeNs: 1n, size: 1n },
    { mtimeNs: 2n, size: 1n },
    { mtimeNs: 1n, size: 2n },
    { mtimeNs: 1n, size: 1n, sha256: "ab".repeat(32) },
    { mtimeNs: 1n, size: 1n, sha256: "cd".repeat(32) },
  ];
  expect(new Set(inputs.map(deriveFileVersion)).size).toBe(5);
});
it("rejects invalid size and hash", () => {
  expect(() => deriveFileVersion({ mtimeNs: 1n, size: -1n })).toThrow();
  expect(() => deriveFileVersion({ mtimeNs: 1n, size: 0n, sha256: "a" })).toThrow();
});
