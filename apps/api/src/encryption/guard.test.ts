import { ENCRYPTED_FOLDER_MARKER } from "@fdrive/contracts";
import { isStorageError, type StorageProvider } from "@fdrive/core";
import { createMemoryStorage } from "@fdrive/core/testing";
import { describe, expect, it } from "vitest";
import {
  checkRestore,
  encryptedAccessAllowed,
  encryptedFolderRefusal,
  encryptedFoldersOf,
  guardEncryptedFolders,
  withEncryptedAccess,
} from "./guard.js";

const RECIPIENT = `age1${"q".repeat(58)}`;
const MARKER = {
  v: 1 as const,
  id: "2f1b8f3e-8c55-4d2b-9a57-1d3b6f0c2a11",
  recipient: RECIPIENT,
  members: [{ recipient: RECIPIENT, key: "YWdl" }],
  mac: `${"A".repeat(43)}=`,
};
const AGE = "age-encryption.org/v1\n-> X25519 body";
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const T3 = "33333333-3333-4333-8333-333333333333";

/** An encrypted name in shape: the guard cannot tell whether it decrypts. */
function enc(letter: string): string {
  return `fe1-${"a".repeat(46)}${letter}`;
}

function storage(extra: Record<string, string> = {}) {
  const inner = createMemoryStorage({
    [`/Private/${ENCRYPTED_FOLDER_MARKER}`]: JSON.stringify(MARKER),
    [`/Private/${enc("b")}`]: AGE,
    [`/Private/${enc("c")}/${enc("d")}`]: AGE,
    "/Other/note.txt": "plain",
    [`/Second/${ENCRYPTED_FOLDER_MARKER}`]: JSON.stringify(MARKER),
    "/.fdrive-desktop/staged": AGE,
    "/.fdrive-desktop/plain": "plain",
    ...extra,
  });
  return { inner, guarded: guardEncryptedFolders(inner) };
}

async function refusal(work: Promise<unknown>): Promise<{ kind: string; code: unknown }> {
  const error = await work.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!isStorageError(error)) throw new Error(`expected a refusal, got ${String(error)}`);
  return { kind: error.kind, code: error.details?.code };
}

const allowed = <T>(work: () => Promise<T>) => withEncryptedAccess(work);

function stream(text: string, pieces = 3): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const size = Math.ceil(bytes.length / pieces);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

describe("outside the allowed list", () => {
  it("refuses everything inside an encrypted folder, but not the folder itself", async () => {
    const { guarded } = storage();
    expect(encryptedAccessAllowed()).toBe(false);
    expect(await refusal(guarded.list("/Private"))).toEqual({
      kind: "forbidden",
      code: "encrypted_folder",
    });
    expect((await refusal(guarded.stat(`/Private/${enc("b")}`))).code).toBe("encrypted_folder");
    expect((await refusal(guarded.open(`/Private/${enc("b")}`))).code).toBe("encrypted_folder");
    expect((await refusal(guarded.statFile(`/Private/${enc("b")}`))).kind).toBe("forbidden");
    expect((await refusal(guarded.contentStamp(`/Private/${enc("b")}`))).kind).toBe("forbidden");
    expect((await refusal(guarded.probeDirectoryRead("/Private"))).kind).toBe("forbidden");
    expect((await refusal(guarded.probeDirectoryRead(`/Private/${enc("c")}`))).kind).toBe(
      "forbidden",
    );
    expect((await refusal(guarded.deleteFile(`/Private/${enc("b")}`))).kind).toBe("forbidden");
    expect((await refusal(guarded.deleteDir(`/Private/${enc("c")}`))).kind).toBe("forbidden");
    expect((await refusal(guarded.deleteEmptyDir(`/Private/${enc("c")}`))).kind).toBe("forbidden");
    expect((await refusal(guarded.trash.put(`/Private/${enc("b")}`, T1))).kind).toBe("forbidden");
    expect((await refusal(guarded.zip(["/Private"]))).kind).toBe("forbidden");
    expect((await refusal(guarded.zip([`/Private/${enc("b")}`]))).kind).toBe("forbidden");
    expect((await guarded.stat("/Private")).kind).toBe("dir");
    await guarded.probeDirectoryRead("/Other");
  });

  it("never shows, reads or writes the marker", async () => {
    const { guarded } = storage();
    expect((await guarded.list("/")).map((entry) => entry.name).sort()).toEqual([
      ".fdrive-desktop",
      "Other",
      "Private",
      "Second",
    ]);
    expect((await refusal(guarded.stat(`/Private/${ENCRYPTED_FOLDER_MARKER}`))).kind).toBe(
      "not_found",
    );
    expect(
      (await refusal(allowed(() => guarded.open(`/Private/${ENCRYPTED_FOLDER_MARKER}`)))).kind,
    ).toBe("not_found");
    expect(
      (
        await refusal(
          allowed(() => guarded.upload(`/Other/${ENCRYPTED_FOLDER_MARKER}`, new Uint8Array())),
        )
      ).kind,
    ).toBe("not_found");
  });

  it("leaves everything outside encrypted folders as it was", async () => {
    const { guarded } = storage();
    await guarded.upload("/Other/new.txt", new TextEncoder().encode("x"));
    await guarded.move("/Other/new.txt", "/Other/moved.txt");
    await guarded.copy("/Other/moved.txt", "/Other/copy.txt");
    expect((await guarded.list("/Other")).map((entry) => entry.name).sort()).toEqual([
      "copy.txt",
      "moved.txt",
      "note.txt",
    ]);
    await guarded.zip(["/Other"]);
  });
});

describe("on the allowed list", () => {
  it("lists an encrypted folder without its marker", async () => {
    const { guarded } = storage();
    const names = await allowed(() => guarded.list("/Private"));
    expect(names.map((entry) => entry.name).sort()).toEqual([enc("b"), enc("c")]);
  });

  it("stores encrypted files under encrypted names only", async () => {
    const { guarded } = storage();
    await allowed(() => guarded.upload(`/Private/${enc("e")}`, stream(AGE)));
    await allowed(() => guarded.upload(`/Private/${enc("f")}`, new TextEncoder().encode(AGE)));
    expect(
      (await refusal(allowed(() => guarded.upload("/Private/clear.txt", stream(AGE))))).kind,
    ).toBe("bad_request");
    expect(
      (
        await refusal(
          allowed(() =>
            guarded.upload(`/Private/${enc("g")}`, stream("plaintext here, long enough")),
          ),
        )
      ).kind,
    ).toBe("bad_request");
    expect(
      (await refusal(allowed(() => guarded.upload(`/Private/${enc("g")}`, stream("age"))))).kind,
    ).toBe("bad_request");
    expect(
      (
        await refusal(
          allowed(() =>
            guarded.upload(
              `/Private/${enc("g")}`,
              new TextEncoder().encode("plaintext!!!!!!!!!!!!!"),
            ),
          ),
        )
      ).code,
    ).toBe("encrypted_folder");
    expect(
      (await refusal(allowed(() => guarded.mkdir(`/Private/${enc("h")}/clear`, { parents: true }))))
        .kind,
    ).toBe("bad_request");
    await allowed(() => guarded.mkdir(`/Private/${enc("h")}`));
  });

  it("checks the first piece of an upload in pieces, not the later ones", async () => {
    const { guarded } = storage();
    const part = (offset: number) => ({ part: { id: "0123456789abcdef", offset } });
    expect(
      (
        await refusal(
          allowed(() =>
            guarded.uploadPart(`/Private/${enc("i")}`, stream("plaintext piece here!!!"), part(0)),
          ),
        )
      ).kind,
    ).toBe("bad_request");
    await allowed(() => guarded.uploadPart(`/Private/${enc("i")}`, stream(AGE), part(0)));
    await allowed(() =>
      guarded.upload(`/Private/${enc("i")}`, stream("rest of the ciphertext"), part(AGE.length)),
    );
  });

  it("moves and copies only within one encrypted folder", async () => {
    const { guarded } = storage();
    await allowed(() => guarded.move(`/Private/${enc("b")}`, `/Private/${enc("c")}/${enc("j")}`));
    await allowed(() => guarded.copy(`/Private/${enc("c")}/${enc("j")}`, `/Private/${enc("k")}`));
    const out = await refusal(allowed(() => guarded.move(`/Private/${enc("k")}`, "/Other/out")));
    expect(out).toEqual({ kind: "forbidden", code: "encrypted_folder" });
    expect(
      (await refusal(allowed(() => guarded.copy("/Other/note.txt", `/Private/${enc("l")}`)))).kind,
    ).toBe("forbidden");
    expect(
      (await refusal(allowed(() => guarded.move(`/Private/${enc("k")}`, `/Second/${enc("k")}`))))
        .kind,
    ).toBe("forbidden");
    expect(
      (await refusal(allowed(() => guarded.move(`/Private/${enc("k")}`, "/Private/clear")))).kind,
    ).toBe("bad_request");
    // A whole encrypted folder moves and copies like any folder, but never into another.
    await allowed(() => guarded.copy("/Second", "/Second copy"));
    await guarded.move("/Second copy", "/Other/Second copy");
    expect(
      (await refusal(allowed(() => guarded.move("/Second", `/Private/${enc("m")}`)))).kind,
    ).toBe("forbidden");
  });

  it("publishes a Mac's staged save into an encrypted folder only when it is encrypted", async () => {
    const { guarded } = storage();
    await allowed(() =>
      guarded.move("/.fdrive-desktop/staged", `/Private/${enc("n")}`, { publish: true }),
    );
    expect(
      (
        await refusal(
          allowed(() =>
            guarded.move("/.fdrive-desktop/plain", `/Private/${enc("o")}`, { publish: true }),
          ),
        )
      ).kind,
    ).toBe("bad_request");
    await guarded.move("/.fdrive-desktop/plain", "/Other/published.txt", { publish: true });
  });

  it("puts encrypted items in Trash and takes them back only into an encrypted folder", async () => {
    const { guarded } = storage();
    const put = await allowed(() => guarded.trash.put(`/Private/${enc("b")}`, T1));
    expect(put).toBeDefined();
    expect(
      (await refusal(allowed(() => guarded.trash.restore(T1, enc("b"), `/Other/${enc("b")}`))))
        .code,
    ).toBe("encrypted_folder");
    expect(
      (await refusal(allowed(() => guarded.trash.restore(T1, enc("b"), "/Private/clear")))).kind,
    ).toBe("bad_request");
    await allowed(() => guarded.trash.restore(T1, enc("b"), `/Private/${enc("b")}`));
    // A trashed encrypted folder comes back anywhere but inside another.
    await guarded.trash.put("/Second", T2);
    expect(
      (await refusal(allowed(() => guarded.trash.restore(T2, "Second", `/Private/${enc("p")}`))))
        .kind,
    ).toBe("forbidden");
    await guarded.trash.restore(T2, "Second", "/Second");
    await guarded.trash.put("/Other/note.txt", T3);
    await guarded.trash.purge(T3);
  });

  it("deletes inside an encrypted folder", async () => {
    const { guarded } = storage();
    await allowed(() => guarded.deleteFile(`/Private/${enc("b")}`));
    await allowed(() => guarded.deleteDir(`/Private/${enc("c")}`));
    await allowed(() => guarded.mkdir(`/Private/${enc("q")}`));
    await allowed(() => guarded.deleteEmptyDir(`/Private/${enc("q")}`));
    expect((await allowed(() => guarded.list("/Private"))).length).toBe(0);
  });

  it("reads files inside an encrypted folder", async () => {
    const { guarded } = storage();
    const file = await allowed(() => guarded.open(`/Private/${enc("b")}`));
    await file.close();
    await allowed(() => guarded.stat(`/Private/${enc("b")}`));
    await allowed(() => guarded.statFile(`/Private/${enc("b")}`));
    await allowed(() => guarded.contentStamp(`/Private/${enc("b")}`));
    await allowed(() => guarded.probeDirectoryRead("/Private"));
  });
});

describe("what a request learns about encrypted folders", () => {
  it("finds the folder a path is or is inside, with its marker", async () => {
    const { guarded } = storage();
    const folders = encryptedFoldersOf(guarded);
    expect(await folders.isFolder("/Private")).toBe(true);
    expect(await folders.isFolder("/")).toBe(false);
    expect(await folders.containing(`/Private/${enc("c")}/${enc("d")}`)).toBe("/Private");
    expect(await folders.containing("/Private")).toBeNull();
    expect(await folders.info(`/Private/${enc("c")}`)).toEqual({
      path: "/Private",
      marker: MARKER,
    });
    expect(await folders.info("/Private")).toEqual({ path: "/Private", marker: MARKER });
    expect(await folders.info("/Other")).toBeNull();
  });

  it("reports a marker it cannot read as no information", async () => {
    const { guarded } = storage({
      [`/Broken/${ENCRYPTED_FOLDER_MARKER}`]: "{",
      [`/Wrong/${ENCRYPTED_FOLDER_MARKER}`]: JSON.stringify({ v: 2 }),
      [`/Huge/${ENCRYPTED_FOLDER_MARKER}`]: "x".repeat(70_000),
    });
    const folders = encryptedFoldersOf(guarded);
    expect(await folders.isFolder("/Broken")).toBe(true);
    expect(await folders.info("/Broken")).toBeNull();
    expect(await folders.info("/Wrong")).toBeNull();
    expect(await folders.info("/Huge")).toBeNull();
  });

  it("writes a new folder's marker once", async () => {
    const { guarded } = storage();
    await guarded.mkdir("/New");
    const folders = encryptedFoldersOf(guarded);
    expect(await folders.isFolder("/New")).toBe(false);
    await folders.writeMarker("/New", MARKER);
    expect(await folders.isFolder("/New")).toBe(true);
    expect((await refusal(folders.writeMarker("/New", MARKER))).kind).toBe("conflict");
  });

  it("passes on a failure that is not about encryption", async () => {
    const { inner, guarded } = storage();
    // A taken name is a conflict, not a refusal.
    const taken = refusal(
      allowed(() => guarded.upload(`/Private/${enc("b")}`, stream(AGE), { overwrite: false })),
    );
    expect((await taken).kind).toBe("conflict");
    const broken = guardEncryptedFolders({
      ...inner,
      open: () => Promise.reject(new Error("disk on fire")),
    });
    await expect(encryptedFoldersOf(broken).info("/Private")).rejects.toThrow("disk on fire");
  });

  it("reads the markers of a storage built without the guard", async () => {
    const { inner } = storage();
    expect(await encryptedFoldersOf(inner as StorageProvider).isFolder("/Private")).toBe(true);
  });

  it("lets a restore go back only to the side of an encrypted folder's edge it came from", async () => {
    const { guarded } = storage();
    await checkRestore(guarded, `/Private/${enc("x")}`, `/Private/${enc("c")}/${enc("x")}`);
    await checkRestore(guarded, "/Other/a.txt", "/Other/b.txt");
    expect((await refusal(checkRestore(guarded, `/Private/${enc("x")}`, "/Other/x"))).code).toBe(
      "encrypted_folder",
    );
    expect(
      (await refusal(checkRestore(guarded, "/Other/a.txt", `/Private/${enc("a")}`))).kind,
    ).toBe("forbidden");
    expect(
      (await refusal(checkRestore(guarded, `/Private/${enc("x")}`, `/Second/${enc("x")}`))).kind,
    ).toBe("forbidden");
  });

  it("names its refusals for clients", () => {
    expect(encryptedFolderRefusal("x").details).toEqual({ code: "encrypted_folder" });
    expect(encryptedFolderRefusal("x", "bad_request").kind).toBe("bad_request");
  });
});
