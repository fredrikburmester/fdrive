import { expect, it } from "vitest";
import { DesktopPairApproval } from "./desktop.js";
import {
  DesktopFolderRequest,
  DesktopName,
  DesktopUploadRequest,
  DesktopWriteApproval,
} from "./desktop-writes.js";

const id = "00000000-0000-4000-8000-000000000001";
it("validates explicit per-identity grants without changing legacy defaults", () => {
  expect(DesktopPairApproval.parse({ identityIds: [id] }).access).toBeUndefined();
  expect(
    DesktopWriteApproval.parse({ identityIds: [id], access: { [id]: "full" } }).access?.[id],
  ).toBe("full");
  expect(
    DesktopWriteApproval.safeParse({ identityIds: [id], access: { [id]: "admin" } }).success,
  ).toBe(false);
});
it("rejects escaping, control, ambiguous and overlong filenames", () => {
  for (const name of ["", ".", "..", "a/b", "a:b", "a\u0000b", "a\u007fb", "🚀".repeat(64)])
    expect(DesktopName.safeParse(name).success).toBe(false);
  expect(DesktopName.parse("å literal % name.txt")).toBe("å literal % name.txt");
  expect(
    DesktopFolderRequest.safeParse({
      operationId: id,
      parentId: "root",
      name: "new",
      unexpected: true,
    }).success,
  ).toBe(false);
});
it("requires a digest and explicit null base for zero-byte uploads", () => {
  const request = {
    operationId: id,
    parentId: "root",
    name: "empty",
    base: null,
    size: 0,
    sha256: "a".repeat(64),
  };
  expect(DesktopUploadRequest.parse(request).size).toBe(0);
  for (const invalid of [
    { ...request, base: undefined },
    { ...request, size: -1 },
    { ...request, sha256: "not-a-hash" },
  ])
    expect(DesktopUploadRequest.safeParse(invalid).success).toBe(false);
});
