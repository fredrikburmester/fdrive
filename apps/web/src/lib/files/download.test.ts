import { describe, expect, it, vi } from "vitest";
import {
  type AnchorLike,
  createAnchorDownloader,
  type DocumentLike,
  type DownloadDeps,
  downloadEntries,
  downloadMany,
  downloadObjectUrl,
  downloadSingle,
  needsZipDownload,
} from "./download";

/** Runs the macrotask the deferred object-URL release is scheduled in. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function fakeDocument() {
  const created: AnchorLike[] = [];
  const clicks: AnchorLike[] = [];
  /** Whether the anchor was in the document each time it was clicked. */
  const attachedAtClick: boolean[] = [];
  let attached: AnchorLike | null = null;
  const anchor: AnchorLike = {
    href: "",
    rel: "",
    download: "",
    style: { display: "" },
    click: () => {
      clicks.push(anchor);
      attachedAtClick.push(attached === anchor);
    },
  };
  const doc: DocumentLike = {
    createElement: () => {
      created.push(anchor);
      return anchor;
    },
    body: {
      appendChild: vi.fn((node: AnchorLike) => {
        attached = node;
      }),
      removeChild: vi.fn((node: AnchorLike) => {
        if (attached === node) attached = null;
      }),
    },
  };
  return { doc, anchor, created, clicks, attachedAtClick, isAttached: () => attached !== null };
}

describe("createAnchorDownloader", () => {
  it("appends, clicks, and removes a hidden anchor", () => {
    const { doc, anchor, clicks, attachedAtClick, isAttached } = fakeDocument();
    const downloader = createAnchorDownloader(doc);

    downloader.click("https://example.test/file.txt");

    expect(anchor.href).toBe("https://example.test/file.txt");
    expect(anchor.rel).toBe("noopener");
    expect(anchor.style.display).toBe("none");
    expect(anchor.download).toBe("");
    expect(clicks).toEqual([anchor]);
    expect(doc.body.appendChild).toHaveBeenCalledWith(anchor);
    expect(doc.body.removeChild).toHaveBeenCalledWith(anchor);
    // A detached anchor is not reliably actionable: it has to be in the
    // document when the click lands, and gone once it has.
    expect(attachedAtClick).toEqual([true]);
    expect(isAttached()).toBe(false);
  });

  it("sets the download filename when given", () => {
    const { doc, anchor } = fakeDocument();
    const downloader = createAnchorDownloader(doc);

    downloader.click("https://example.test/z.zip", "archive.zip");

    expect(anchor.download).toBe("archive.zip");
  });
});

describe("downloadObjectUrl", () => {
  it("keeps the object URL alive past the click and releases it one task later", async () => {
    const revokeObjectUrl = vi.fn();
    /** What had already been revoked when the click landed. */
    const revokedAtClick: unknown[][] = [];
    const anchor = {
      click: vi.fn(() => {
        revokedAtClick.push(revokeObjectUrl.mock.calls.flat());
      }),
    };

    downloadObjectUrl("blob:one", "one.txt", { anchor, revokeObjectUrl });

    expect(anchor.click).toHaveBeenCalledWith("blob:one", "one.txt");
    expect(revokedAtClick).toEqual([[]]);
    // Still live after the handler returns: the browser reads the blob
    // while it processes the click, which is not over yet.
    expect(revokeObjectUrl).not.toHaveBeenCalled();

    await nextTask();

    expect(revokeObjectUrl).toHaveBeenCalledOnce();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:one");
  });

  it("releases the object URL even when the click throws", async () => {
    const revokeObjectUrl = vi.fn();
    const anchor = {
      click: vi.fn(() => {
        throw new Error("boom");
      }),
    };

    expect(() => downloadObjectUrl("blob:two", "two.txt", { anchor, revokeObjectUrl })).toThrow(
      "boom",
    );

    await nextTask();

    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:two");
  });
});

describe("needsZipDownload", () => {
  it("is false for a single file", () => {
    expect(needsZipDownload([{ kind: "file" }])).toBe(false);
  });

  it("is true for a single folder", () => {
    expect(needsZipDownload([{ kind: "dir" }])).toBe(true);
  });

  it("is true for several files", () => {
    expect(needsZipDownload([{ kind: "file" }, { kind: "file" }])).toBe(true);
  });

  it("is true for a mixed selection of files and folders", () => {
    expect(needsZipDownload([{ kind: "file" }, { kind: "dir" }])).toBe(true);
  });

  it("is true for an empty selection", () => {
    expect(needsZipDownload([])).toBe(true);
  });
});

describe("downloadEntries", () => {
  const file = { kind: "file", path: "/docs/a.txt" };
  const other = { kind: "file", path: "/docs/b.txt" };
  const dir = { kind: "dir", path: "/docs/photos" };

  function deps(): DownloadDeps {
    return {
      downloadUrl: vi.fn((path: string) => `https://example.test/download?path=${path}`),
      zip: vi.fn().mockResolvedValue(new Response(new Blob(["zip"]), { status: 200 })),
      anchor: { click: vi.fn() },
      createObjectUrl: vi.fn().mockReturnValue("blob:fake"),
      revokeObjectUrl: vi.fn(),
    };
  }

  it("streams a single file directly, without a zip", async () => {
    const d = deps();
    await downloadEntries([file], d);
    expect(d.downloadUrl).toHaveBeenCalledWith("/docs/a.txt", { inline: false });
    expect(d.anchor.click).toHaveBeenCalledWith("https://example.test/download?path=/docs/a.txt");
    expect(d.zip).not.toHaveBeenCalled();
  });

  it("zips a folder, named after it", async () => {
    const d = deps();
    await downloadEntries([dir], d);
    expect(d.zip).toHaveBeenCalledWith(["/docs/photos"], "photos.zip");
    expect(d.anchor.click).toHaveBeenCalledWith("blob:fake", "photos.zip");
    expect(d.downloadUrl).not.toHaveBeenCalled();
  });

  it("zips several entries, named after their folder", async () => {
    const d = deps();
    await downloadEntries([file, dir, other], d);
    expect(d.zip).toHaveBeenCalledWith(["/docs/a.txt", "/docs/photos", "/docs/b.txt"], "docs.zip");
  });

  it("does nothing for an empty selection", async () => {
    const d = deps();
    await downloadEntries([], d);
    expect(d.zip).not.toHaveBeenCalled();
    expect(d.anchor.click).not.toHaveBeenCalled();
  });

  it("rejects when the zip fails", async () => {
    const d = { ...deps(), zip: vi.fn().mockResolvedValue(new Response(null, { status: 500 })) };
    await expect(downloadEntries([dir], d)).rejects.toThrow("zip request failed with status 500");
  });
});

describe("downloadSingle", () => {
  it("clicks a non-inline download URL for the path", () => {
    const { doc, clicks, anchor } = fakeDocument();
    const downloadUrl = vi.fn().mockReturnValue("https://example.test/download?path=%2Fa");
    const deps: DownloadDeps = {
      downloadUrl,
      zip: vi.fn(),
      anchor: createAnchorDownloader(doc),
      createObjectUrl: vi.fn(),
      revokeObjectUrl: vi.fn(),
    };

    downloadSingle("/a", deps);

    expect(downloadUrl).toHaveBeenCalledWith("/a", { inline: false });
    expect(clicks).toEqual([anchor]);
  });
});

describe("downloadMany", () => {
  function deps(overrides: Partial<DownloadDeps> = {}): DownloadDeps {
    const { doc } = fakeDocument();
    return {
      downloadUrl: vi.fn(),
      zip: vi.fn(),
      anchor: createAnchorDownloader(doc),
      createObjectUrl: vi.fn().mockReturnValue("blob:fake"),
      revokeObjectUrl: vi.fn(),
      ...overrides,
    };
  }

  it("zips, downloads, and revokes the object URL", async () => {
    const blob = new Blob(["zip bytes"]);
    const response = new Response(blob, { status: 200 });
    const clickSpy = vi.fn();
    const d = deps({
      zip: vi.fn().mockResolvedValue(response),
      anchor: { click: clickSpy },
    });

    await downloadMany(["/a", "/b"], d, "export.zip");

    expect(d.zip).toHaveBeenCalledWith(["/a", "/b"], "export.zip");
    expect(d.createObjectUrl).toHaveBeenCalledOnce();
    expect(clickSpy).toHaveBeenCalledWith("blob:fake", "export.zip");
    expect(d.revokeObjectUrl).not.toHaveBeenCalled();

    await nextTask();

    expect(d.revokeObjectUrl).toHaveBeenCalledWith("blob:fake");
  });

  it("falls back to a default filename when none is given", async () => {
    const response = new Response(new Blob(["x"]), { status: 200 });
    const clickSpy = vi.fn();
    const d = deps({ zip: vi.fn().mockResolvedValue(response), anchor: { click: clickSpy } });

    await downloadMany(["/a"], d);

    expect(clickSpy).toHaveBeenCalledWith("blob:fake", "download.zip");
  });

  it("throws and does not download when the response is not ok", async () => {
    const response = new Response(null, { status: 500 });
    const d = deps({ zip: vi.fn().mockResolvedValue(response) });

    await expect(downloadMany(["/a"], d)).rejects.toThrow("zip request failed with status 500");
    expect(d.createObjectUrl).not.toHaveBeenCalled();
  });

  it("still revokes the object URL when the anchor click throws", async () => {
    const response = new Response(new Blob(["x"]), { status: 200 });
    const clickSpy = vi.fn(() => {
      throw new Error("boom");
    });
    const d = deps({ zip: vi.fn().mockResolvedValue(response), anchor: { click: clickSpy } });

    await expect(downloadMany(["/a"], d)).rejects.toThrow("boom");

    await nextTask();

    expect(d.revokeObjectUrl).toHaveBeenCalledWith("blob:fake");
  });
});
