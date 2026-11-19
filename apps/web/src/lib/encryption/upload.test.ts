import { decryptName, decryptStream, NameTooLongError } from "@fdrive/crypto";
import { describe, expect, it } from "vitest";
import type { UploadItem } from "@/lib/upload/types";
import { encryptedFolder } from "@/test-fixtures/encryption";
import { prepareEncryptedUploads } from "./upload";

function item(relativePath: string, contents = "x"): UploadItem {
  return {
    id: relativePath,
    file: new File([contents], relativePath.split("/").at(-1) ?? relativePath),
    targetPath: `/Private/${relativePath}`,
    relativePath,
    size: contents.length,
    status: "queued",
    progress: 0,
    attempts: 0,
  };
}

describe("uploads into an encrypted folder", () => {
  it("names every segment encrypted, one name per folder in the batch", async () => {
    const { folder } = await encryptedFolder();
    const prepared = await prepareEncryptedUploads(
      [item("Photos/a.jpg"), item("Photos/b.jpg"), item("note.txt")],
      { destination: "/Private", folder, storedByName: new Map() },
    );
    const [a, b, note] = prepared.map((upload) => upload.targetPath.split("/").slice(2));
    expect(a?.[0]).toBe(b?.[0]);
    expect(a?.[1]).not.toBe(b?.[1]);
    expect(await decryptName(a?.[0] ?? "", folder.nameKey, folder.id)).toBe("Photos");
    expect(await decryptName(note?.[0] ?? "", folder.nameKey, folder.id)).toBe("note.txt");
    // The queue shows the clear path.
    expect(prepared[0]?.relativePath).toBe("Photos/a.jpg");
  });

  it("reuses what is already there by its clear name", async () => {
    const { folder } = await encryptedFolder();
    const [upload] = await prepareEncryptedUploads([item("Photos/a.jpg")], {
      destination: "/Private",
      folder,
      storedByName: new Map([["Photos", "fe1-existing"]]),
    });
    expect(upload?.targetPath.startsWith("/Private/fe1-existing/fe1-")).toBe(true);
  });

  it("encrypts each file as it starts", async () => {
    const { folder } = await encryptedFolder();
    const [upload] = await prepareEncryptedUploads([item("a.txt", "secret")], {
      destination: "/Private",
      folder,
      storedByName: new Map(),
    });
    const cipher = (await upload?.source?.()) as Blob;
    const plain = await new Response(await decryptStream(cipher.stream(), folder.identity)).text();
    expect(plain).toBe("secret");
  });

  it("refuses a name an encrypted folder cannot hold", async () => {
    const { folder } = await encryptedFolder();
    await expect(
      prepareEncryptedUploads([item(`${"x".repeat(200)}.txt`)], {
        destination: "/Private",
        folder,
        storedByName: new Map(),
      }),
    ).rejects.toBeInstanceOf(NameTooLongError);
  });
});
