import { expect, it, vi } from "vitest";
import { officeHarness } from "../../test/fixtures/office/harness.ts";

it.each(["onlyoffice", "collabora"] as const)(
  "uses a content version with product-specific timestamp reporting for %s",
  async (product) => {
    const h = await officeHarness({ config: { product } });
    const download = h.storage.download.bind(h.storage);
    const modified = new Date("2026-09-07T00:00:00Z");
    vi.spyOn(h.storage, "download").mockImplementation(async (...args) => ({
      ...(await download(...args)),
      lastModified: modified,
    }));
    const opened = await h.open("/a.docx", "view");
    const before = (await (await h.callback(opened)).json()) as {
      Version: string;
      Size: number;
      LastModifiedTime?: string;
    };
    expect(before.LastModifiedTime).toBe(
      product === "collabora" ? modified.toISOString() : undefined,
    );
    await h.storage.upload("/a.docx", Buffer.from("world"));
    const after = (await (await h.callback(opened)).json()) as typeof before;
    expect(after.Size).toBe(before.Size);
    expect(after.LastModifiedTime).toBe(before.LastModifiedTime);
    expect(after.Version).not.toBe(before.Version);
    vi.spyOn(h.storage, "download").mockImplementation(async (...args) => ({
      ...(await download(...args)),
      lastModified: null,
    }));
    expect(await (await h.callback(opened)).json()).not.toHaveProperty("LastModifiedTime");
  },
);
