import { describe, expect, it, vi } from "vitest";
import {
  type AnchorLike,
  createAnchorDownloader,
  type DocumentLike,
  type DownloadDeps,
  downloadMany,
  downloadSingle,
} from "./download";

function fakeDocument() {
  const created: AnchorLike[] = [];
  const clicks: AnchorLike[] = [];
  const anchor: AnchorLike = {
    href: "",
    rel: "",
    download: "",
    style: { display: "" },
    click: () => clicks.push(anchor),
  };
  const doc: DocumentLike = {
    createElement: () => {
      created.push(anchor);
      return anchor;
    },
    body: {
      appendChild: vi.fn(),
      removeChild: vi.fn(),
    },
  };
  return { doc, anchor, created, clicks };
}

describe("createAnchorDownloader", () => {
  it("appends, clicks, and removes a hidden anchor", () => {
    const { doc, anchor, clicks } = fakeDocument();
    const downloader = createAnchorDownloader(doc);

    downloader.click("https://example.test/file.txt");

    expect(anchor.href).toBe("https://example.test/file.txt");
    expect(anchor.rel).toBe("noopener");
    expect(anchor.style.display).toBe("none");
    expect(anchor.download).toBe("");
    expect(clicks).toEqual([anchor]);
    expect(doc.body.appendChild).toHaveBeenCalledWith(anchor);
    expect(doc.body.removeChild).toHaveBeenCalledWith(anchor);
  });

  it("sets the download filename when given", () => {
    const { doc, anchor } = fakeDocument();
    const downloader = createAnchorDownloader(doc);

    downloader.click("https://example.test/z.zip", "archive.zip");

    expect(anchor.download).toBe("archive.zip");
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
    expect(d.revokeObjectUrl).toHaveBeenCalledWith("blob:fake");
  });
});
