import type { ManagedShare } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import {
  canUploadShare,
  initialShareFields,
  localDateInput,
  passwordFromBytes,
  shareRequest,
} from "./forms";

const file = { name: "hello.txt", path: "/hello.txt", kind: "file" as const };
const dir = { name: "Folder", path: "/Folder", kind: "dir" as const };
const share: ManagedShare = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Link",
  description: "Details",
  scope: "read",
  paths: [file.path],
  publicPath: "/s/00000000-0000-4000-8000-000000000001",
  hasPassword: true,
  expiresAt: "2030-01-02T03:04:00Z",
  maxDownloads: 3,
  usedDownloads: 1,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  presentation: "gallery",
};
describe("share forms", () => {
  it("defaults basename, read access and unlimited use", () => {
    const fields = initialShareFields([file]);
    expect(fields).toMatchObject({
      name: "hello.txt",
      scope: "read",
      presentation: "auto",
      password: "",
      expires: "",
      maxDownloads: "",
    });
    expect(initialShareFields([]).name).toBe("Shared files");
    expect(initialShareFields([file, dir]).name).toBe("Shared files");
    expect(shareRequest(fields, [file], false)).toMatchObject({
      paths: [file.path],
      password: "",
      expiresAt: null,
      maxDownloads: 0,
      presentation: "auto",
    });
    expect(canUploadShare([dir])).toBe(true);
    expect(canUploadShare([file])).toBe(false);
    expect(canUploadShare([])).toBe(false);
  });
  it("preserves existing password unless explicitly changed or removed", () => {
    const fields = initialShareFields([file], share);
    expect(fields).toMatchObject({
      name: "Link",
      description: "Details",
      maxDownloads: "3",
      passwordAction: "keep",
      password: "",
      presentation: "gallery",
    });
    expect(shareRequest(fields, [file], true)).not.toHaveProperty("password");
    expect(
      shareRequest({ ...fields, passwordAction: "change", password: "new" }, [file], true),
    ).toHaveProperty("password", "new");
    expect(shareRequest({ ...fields, passwordAction: "remove" }, [file], true)).toHaveProperty(
      "password",
      "",
    );
    expect(() => shareRequest({ ...fields, passwordAction: "change" }, [file], true)).toThrow(
      "Enter the new password",
    );
    expect(
      initialShareFields([file], { ...share, maxDownloads: 0, expiresAt: null }).maxDownloads,
    ).toBe("");
  });
  it("validates folders, expiration, limits, and schema fields", () => {
    const fields = initialShareFields([file]);
    expect(() => shareRequest({ ...fields, scope: "write" }, [file], false)).toThrow("one folder");
    expect(shareRequest({ ...fields, scope: "write" }, [dir], false).scope).toBe("write");
    for (const expires of ["invalid", "2030-02-31T10:00", "2030-01-01"])
      expect(() => shareRequest({ ...fields, expires }, [file], false)).toThrow("valid expiration");
    for (const maxDownloads of ["1.5", "-1", "oops", " "])
      expect(() => shareRequest({ ...fields, maxDownloads }, [file], false)).toThrow(
        "whole number",
      );
    // SFTPGo keeps the limit in a 32-bit `max_tokens` column on its PostgreSQL and
    // MySQL providers, so the form stops just past signed 32-bit rather than at
    // the far larger safe-integer ceiling.
    for (const maxDownloads of ["2147483648", "999999999999999999"])
      expect(() => shareRequest({ ...fields, maxDownloads }, [file], false)).toThrow("too large");
    expect(shareRequest({ ...fields, maxDownloads: "2147483647" }, [file], false)).toMatchObject({
      maxDownloads: 2_147_483_647,
    });
    expect(() => shareRequest({ ...fields, name: " " }, [file], false)).toThrow("Check the name");
    expect(localDateInput(null)).toBe("");
    expect(() => localDateInput("bad")).toThrow("valid expiration");
    const local = localDateInput("2030-01-02T03:04:00Z");
    expect(
      shareRequest({ ...fields, expires: local, maxDownloads: "2" }, [file], false),
    ).toMatchObject({ expiresAt: "2030-01-02T03:04:00.000Z", maxDownloads: 2 });
  });
  it("maps random bytes to a password of the same length using only unambiguous characters", () => {
    const first = passwordFromBytes(new Uint8Array([0, 1, 2, 255]));
    expect(first).toHaveLength(4);
    expect(first).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789]+$/);
    expect(passwordFromBytes(new Uint8Array())).toBe("");
    expect(passwordFromBytes(new Uint8Array([0, 0]))).toBe("AA");
  });
});
