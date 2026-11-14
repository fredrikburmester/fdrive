import { expect, it, vi } from "vitest";
import { officeHarness } from "../../test/fixtures/office/harness.ts";

it.each(["onlyoffice", "collabora"] as const)(
  "versions from the file's stamp, with product-specific timestamp reporting for %s",
  async (product) => {
    const h = await officeHarness({ config: { product } });
    const modified = new Date("2026-09-07T00:00:00Z");
    await h.storage.upload("/a.docx", Buffer.from("hello"), { modifiedAt: modified });
    const opened = await h.open("/a.docx", "view");
    const download = vi.spyOn(h.storage, "download");
    const info = async () =>
      (await (await h.callback(opened)).json()) as {
        Version: string;
        Size: number;
        LastModifiedTime?: string;
      };
    const before = await info();
    expect(before.LastModifiedTime).toBe(
      product === "collabora" ? modified.toISOString() : undefined,
    );
    expect((await info()).Version).toBe(before.Version);
    // Same size and modification time, as a writer outside fdrive could leave it.
    await h.storage.upload("/a.docx", Buffer.from("world"), { modifiedAt: modified });
    const after = await info();
    expect(after.Size).toBe(before.Size);
    expect(after.LastModifiedTime).toBe(before.LastModifiedTime);
    expect(after.Version).not.toBe(before.Version);
    expect(download).not.toHaveBeenCalled();
  },
);
