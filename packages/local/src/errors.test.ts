import { CoreError, StorageError } from "@fdrive/core";
import { describe, expect, it } from "vitest";
import { codeOf, isAbort, mapped, toStorageError } from "./errors.js";

function systemError(code: string): Error {
  return Object.assign(new Error(`${code}: /srv/data/alice/secret`), { code });
}

describe("codeOf", () => {
  it("reads a string code and nothing else", () => {
    expect(codeOf(systemError("ENOENT"))).toBe("ENOENT");
    expect(codeOf({ code: 5 })).toBeUndefined();
    expect(codeOf(new Error("plain"))).toBeUndefined();
    expect(codeOf("ENOENT")).toBeUndefined();
    expect(codeOf(null)).toBeUndefined();
  });
});

describe("toStorageError", () => {
  it.each([
    ["ENOENT", "not_found"],
    ["ENOTDIR", "not_found"],
    ["EEXIST", "conflict"],
    ["ENOTEMPTY", "conflict"],
    ["ERR_FS_CP_DIR_TO_NON_DIR", "conflict"],
    ["EISDIR", "bad_request"],
    ["ERR_FS_CP_EINVAL", "bad_request"],
    ["EACCES", "forbidden"],
    ["EROFS", "forbidden"],
    ["ENOSPC", "payload_too_large"],
    ["EMFILE", "upstream_unavailable"],
    ["EIO", "internal"],
  ])("maps %s to %s without leaking the path on disk", (code, kind) => {
    const error = toStorageError(systemError(code), "/secret");
    expect(error).toMatchObject({ kind, details: { code } });
    expect((error as StorageError).message).not.toContain("/srv/data");
    expect((error as StorageError).message).toContain("/secret");
  });

  it("maps an error without a code to internal", () => {
    const error = toStorageError(new Error("strange"), "/x");
    expect(error).toMatchObject({ kind: "internal", message: "internal: /x" });
    expect((error as StorageError).details).toBeUndefined();
  });

  it("maps an invalid path to a bad request", () => {
    expect(toStorageError(new CoreError("invalid_path", "NUL"), "/x")).toMatchObject({
      kind: "bad_request",
    });
  });

  it("passes storage errors and aborts through", () => {
    const storage = new StorageError("conflict", "taken");
    const abort = new DOMException("stop", "AbortError");
    expect(toStorageError(storage, "/x")).toBe(storage);
    expect(toStorageError(abort, "/x")).toBe(abort);
    expect(isAbort(abort)).toBe(true);
    expect(isAbort(new Error("x"))).toBe(false);
  });
});

describe("mapped", () => {
  it("returns the result or the mapped failure", async () => {
    await expect(mapped("/x", async () => 7)).resolves.toBe(7);
    await expect(
      mapped("/x", async () => {
        throw systemError("ENOENT");
      }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });
});
