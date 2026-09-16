// @vitest-environment jsdom
import type { FsEntry } from "@fdrive/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Inspector } from "./inspector";

const useFolderSizeMock = vi.fn();

vi.mock("@/lib/inspector/queries", () => ({
  useFolderSize: (...args: unknown[]) => useFolderSizeMock(...args),
}));

vi.mock("@/components/metadata/entry-metadata-section", () => ({
  EntryMetadataSection: () => null,
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

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: true,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  useFolderSizeMock.mockReset();
});

afterEach(() => {
  cleanup();
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

  it("falls back to the kind icon when the image fails to load", () => {
    render(<Inspector entries={[heicEntry]} onClose={() => {}} />);

    fireEvent.error(screen.getByRole("img", { name: "photo.heic" }));

    expect(screen.queryByRole("img", { name: "photo.heic" })).toBeNull();
  });
});
