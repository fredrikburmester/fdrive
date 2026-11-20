// @vitest-environment jsdom
import type { FsEntry } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Inspector } from "./inspector";

const useFolderSizeMock = vi.fn();
const usePhotoDetailsMock = vi.fn();

vi.mock("@/components/activity/file-activity-section", () => ({
  FileActivitySection: ({ path }: { path: string }) => (
    <section aria-label="Activity" data-path={path} />
  ),
}));

vi.mock("@/lib/inspector/queries", () => ({
  useFolderSize: (...args: unknown[]) => useFolderSizeMock(...args),
  usePhotoDetails: (...args: unknown[]) => usePhotoDetailsMock(...args),
}));

vi.mock("@/components/metadata/entry-metadata-section", () => ({
  EntryMetadataSection: ({ entries }: { entries: readonly FsEntry[] }) => (
    <div data-testid="metadata">{entries.map((entry) => entry.path).join(",")}</div>
  ),
}));

vi.mock("@/lib/preview/deps", () => ({
  apiClient: {
    downloadUrl: (path: string) => `https://example.test${path}`,
    thumbUrl: (path: string, size: number) =>
      `https://example.test/thumb?path=${path}&size=${size}`,
  },
}));

const DIR_ENTRY: FsEntry = {
  name: "photos",
  path: "/photos",
  kind: "dir",
  size: 0,
  modifiedAt: "2024-06-14T09:00:00.000Z",
  ext: "",
  mime: null,
};

const FILE_ENTRY: FsEntry = {
  name: "report.pdf",
  path: "/docs/report.pdf",
  kind: "file",
  size: 2048,
  modifiedAt: "2024-06-14T09:00:00.000Z",
  ext: ".pdf",
  mime: null,
};

/** The panel is an aside on a wide window and a sheet on a narrow one. */
function stubWindow(wide: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: wide,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

/** The label and value pairs the panel lists. */
function factsOf(panel: HTMLElement): Record<string, string | null | undefined> {
  return Object.fromEntries(
    [...panel.querySelectorAll("dt")].map((term) => [
      term.textContent ?? "",
      term.nextElementSibling?.textContent,
    ]),
  );
}

beforeEach(() => {
  stubWindow(true);
  useFolderSizeMock.mockReset();
  usePhotoDetailsMock.mockReset();
  usePhotoDetailsMock.mockReturnValue({ data: undefined });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Inspector: the panel", () => {
  it("is a sheet beside the file list: panel ground, a hairline on its left, no shadow", () => {
    render(<Inspector entries={[FILE_ENTRY]} onClose={() => {}} />);

    const panel = screen.getByRole("complementary", { name: "Info" });
    expect(panel.className).toContain("bg-panel");
    expect(panel.className).toContain("border-l");
    expect(panel.className).not.toContain("bg-card");
    expect(panel.className).not.toContain("shadow");
    // Its width is the one the file browser lays out around.
    expect(panel.className).toContain("w-80");
  });

  it("titles the panel with the file's name, and its kind and size on a quiet line", () => {
    render(<Inspector entries={[FILE_ENTRY]} onClose={() => {}} />);

    const panel = within(screen.getByRole("complementary", { name: "Info" }));
    const title = panel.getByRole("heading", { level: 2, name: "report.pdf" });
    // The name is said once, and never cut short.
    expect(panel.getAllByText("report.pdf")).toHaveLength(1);
    expect(title.className).not.toContain("truncate");
    expect(panel.getByText("PDF Document · 2.0 KB")).toBeTruthy();
  });

  it("lists the entry's facts under a small heading, each label with its value", () => {
    render(<Inspector entries={[FILE_ENTRY]} onClose={() => {}} />);

    const panel = screen.getByRole("complementary", { name: "Info" });
    expect(within(panel).getByRole("heading", { level: 3, name: "Details" })).toBeTruthy();
    const facts = factsOf(panel);
    expect(Object.keys(facts)).toEqual(["Kind", "Size", "Modified", "Location", "Extension"]);
    expect(facts).toMatchObject({
      Kind: "PDF Document",
      Size: "2.0 KB",
      Location: "/docs",
      Extension: ".pdf",
    });
    expect(within(panel).getByTestId("metadata").textContent).toBe("/docs/report.pdf");
  });

  it("names a folder's kind alone until its size is known", () => {
    useFolderSizeMock.mockReturnValue({ isPending: true, isError: false, data: undefined });
    const view = render(<Inspector entries={[DIR_ENTRY]} onClose={() => {}} />);
    expect(screen.getByText("Folder", { selector: "p" })).toBeTruthy();

    useFolderSizeMock.mockReturnValue({
      isPending: false,
      isError: false,
      data: { bytes: 2048, files: 12, indexed: true },
    });
    view.rerender(<Inspector entries={[DIR_ENTRY]} onClose={() => {}} />);
    expect(screen.getByText("Folder · 2.0 KB")).toBeTruthy();
  });

  it("closes from its close button", () => {
    const onClose = vi.fn();
    render(<Inspector entries={[FILE_ENTRY]} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Close info" }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("says when nothing is selected", () => {
    render(<Inspector entries={[]} onClose={() => {}} />);

    const panel = screen.getByRole("complementary", { name: "Info" });
    expect(within(panel).getByRole("heading", { level: 2, name: "No selection" })).toBeTruthy();
    expect(within(panel).getByText("Select a file or folder to see its details.")).toBeTruthy();
    expect(factsOf(panel)).toEqual({});
    expect(within(panel).queryByTestId("metadata")).toBeNull();
    expect(within(panel).getByRole("button", { name: "Close info" })).toBeTruthy();
  });

  it("sums up several selected items, and tags or favorites them together", () => {
    render(<Inspector entries={[FILE_ENTRY, DIR_ENTRY]} onClose={() => {}} />);

    const panel = screen.getByRole("complementary", { name: "Info" });
    expect(within(panel).getByRole("heading", { level: 2, name: "2 items selected" })).toBeTruthy();
    expect(within(panel).getByText("2.0 KB total")).toBeTruthy();
    expect(factsOf(panel)).toEqual({});
    expect(within(panel).getByTestId("metadata").textContent).toBe("/docs/report.pdf,/photos");
  });

  it("is a sheet named Info on a narrow window, with the same header and its own close", async () => {
    stubWindow(false);
    const onClose = vi.fn();
    render(<Inspector entries={[FILE_ENTRY]} onClose={onClose} />);

    const sheet = await screen.findByRole("dialog", { name: "Info" });
    expect(screen.queryByRole("complementary", { name: "Info" })).toBeNull();
    expect(within(sheet).getByRole("heading", { level: 2, name: "report.pdf" })).toBeTruthy();
    expect(within(sheet).getByText("PDF Document · 2.0 KB")).toBeTruthy();
    expect(factsOf(sheet).Kind).toBe("PDF Document");

    fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("Inspector: folder size states", () => {
  it("shows Calculating while the folder size query is pending", () => {
    useFolderSizeMock.mockReturnValue({ isPending: true, isError: false, data: undefined });

    render(<Inspector entries={[DIR_ENTRY]} onClose={() => {}} />);

    expect(screen.getAllByText("Calculating")).toHaveLength(2);
  });

  it("shows Not indexed when the folder is out of the index", () => {
    useFolderSizeMock.mockReturnValue({
      isPending: false,
      isError: false,
      data: { bytes: 0, files: 0, indexed: false },
    });

    render(<Inspector entries={[DIR_ENTRY]} onClose={() => {}} />);

    expect(screen.getAllByText("Not indexed")).toHaveLength(2);
  });

  it("shows Not indexed without asking when the files folder is not indexed", () => {
    useFolderSizeMock.mockReturnValue({ isPending: true, isError: false, data: undefined });

    render(<Inspector entries={[DIR_ENTRY]} onClose={() => {}} indexed={false} />);

    expect(useFolderSizeMock).toHaveBeenCalledWith("/photos", { enabled: false });
    expect(screen.getAllByText("Not indexed")).toHaveLength(2);
    expect(screen.queryByText("Calculating")).toBeNull();
  });

  it("shows the real size and file count once indexed, with a note", () => {
    useFolderSizeMock.mockReturnValue({
      isPending: false,
      isError: false,
      data: { bytes: 2048, files: 12, indexed: true },
    });

    render(<Inspector entries={[DIR_ENTRY]} onClose={() => {}} />);

    expect(screen.getByText("2.0 KB")).not.toBeNull();
    expect(screen.getByText("12")).not.toBeNull();
    expect(screen.getByText("From the index")).not.toBeNull();
  });

  it("never queries folder size for a file entry", () => {
    useFolderSizeMock.mockReturnValue({ isPending: false, isError: false, data: undefined });
    const fileEntry: FsEntry = {
      name: "report.pdf",
      path: "/report.pdf",
      kind: "file",
      size: 2048,
      modifiedAt: "2024-06-14T09:00:00.000Z",
      ext: ".pdf",
      mime: null,
    };

    render(<Inspector entries={[fileEntry]} onClose={() => {}} />);

    expect(useFolderSizeMock).toHaveBeenCalledWith("/report.pdf", { enabled: false });
  });
});

describe("Inspector: image preview", () => {
  const heicEntry: FsEntry = {
    name: "photo.heic",
    path: "/photo.heic",
    kind: "file",
    size: 500,
    modifiedAt: "2024-06-14T09:00:00.000Z",
    ext: ".heic",
    mime: "image/heic",
  };

  it("shows the indexer thumbnail for a HEIC, not the raw file", () => {
    render(<Inspector entries={[heicEntry]} onClose={() => {}} />);

    expect(screen.getByRole("img", { name: "photo.heic" }).getAttribute("src")).toBe(
      "https://example.test/thumb?path=/photo.heic&size=256",
    );
  });

  it("shows the indexer thumbnail for a camera raw, never the raw file", () => {
    const rawEntry: FsEntry = {
      ...heicEntry,
      name: "DSC00001.ARW",
      path: "/DSC00001.ARW",
      ext: ".arw",
      mime: "image/x-sony-arw",
      size: 40_000_000,
    };
    render(<Inspector entries={[rawEntry]} onClose={() => {}} />);

    expect(screen.getByRole("img", { name: "DSC00001.ARW" }).getAttribute("src")).toBe(
      "https://example.test/thumb?path=/DSC00001.ARW&size=256",
    );
  });

  it("shows the details the photo has, and asks only for an image while indexed", () => {
    useFolderSizeMock.mockReturnValue({ isPending: true, isError: false, data: undefined });
    usePhotoDetailsMock.mockReturnValue({
      data: {
        takenAt: null,
        camera: "Apple iPhone 15 Pro",
        width: 3024,
        height: 4032,
        latitude: 59.5,
        longitude: 18.25,
      },
    });
    render(<Inspector entries={[heicEntry]} onClose={() => {}} />);

    expect(usePhotoDetailsMock).toHaveBeenCalledWith("/photo.heic", { enabled: true });
    expect(screen.getByText("Apple iPhone 15 Pro")).toBeTruthy();
    expect(screen.getByText("3024 \u00d7 4032")).toBeTruthy();
    expect(screen.getByText("59.50000, 18.25000")).toBeTruthy();
    expect(screen.queryByText("Taken")).toBeNull();

    cleanup();
    render(<Inspector entries={[heicEntry]} onClose={() => {}} indexed={false} />);
    expect(usePhotoDetailsMock).toHaveBeenLastCalledWith("/photo.heic", { enabled: false });
    cleanup();
    render(<Inspector entries={[DIR_ENTRY]} onClose={() => {}} />);
    expect(usePhotoDetailsMock).toHaveBeenLastCalledWith("/photos", { enabled: false });
  });

  it("falls back to the kind icon when the image fails to load", () => {
    render(<Inspector entries={[heicEntry]} onClose={() => {}} />);

    fireEvent.error(screen.getByRole("img", { name: "photo.heic" }));

    expect(screen.queryByRole("img", { name: "photo.heic" })).toBeNull();
  });
});

describe("Inspector: activity", () => {
  it("shows a single entry's activity inline, and none for a multi-selection", () => {
    useFolderSizeMock.mockReturnValue({ isPending: true, isError: false, data: undefined });
    const fileEntry: FsEntry = { ...DIR_ENTRY, name: "a.txt", path: "/a.txt", kind: "file" };

    const { rerender } = render(<Inspector entries={[fileEntry]} onClose={() => {}} />);

    expect(screen.getByRole("region", { name: "Activity" }).getAttribute("data-path")).toBe(
      "/a.txt",
    );
    expect(screen.queryByRole("button", { name: "File journey" })).toBeNull();

    rerender(<Inspector entries={[fileEntry, DIR_ENTRY]} onClose={() => {}} />);

    expect(screen.queryByRole("region", { name: "Activity" })).toBeNull();
  });
});
