// @vitest-environment jsdom
import type { FsEntry } from "@fdrive/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PreviewViewer } from "./preview-viewer";

vi.mock("./archive-preview", () => ({
  ArchivePreview: ({ entry, downloadUrl }: { entry: FsEntry; downloadUrl: string }) => (
    <div data-testid="archive-preview">
      {entry.path} {downloadUrl}
    </div>
  ),
}));

afterEach(cleanup);

const archiveEntry: FsEntry = {
  name: "docs.zip",
  path: "/docs.zip",
  kind: "file",
  ext: ".zip",
  mime: null,
  size: 100,
  modifiedAt: "2026-09-07T00:00:00Z",
};

it("renders ArchivePreview for the archive preview kind", () => {
  render(<PreviewViewer entry={archiveEntry} inlineUrl="/inline" downloadUrl="/download" />);

  expect(screen.getByTestId("archive-preview").textContent).toBe("/docs.zip /download");
});

const heicEntry: FsEntry = {
  name: "photo.heic",
  path: "/photo.heic",
  kind: "file",
  ext: ".heic",
  mime: "image/heic",
  size: 500,
  modifiedAt: "2026-09-07T00:00:00Z",
};

it("renders ImageViewer with thumb-first fallback for HEIC images", () => {
  render(
    <PreviewViewer
      entry={heicEntry}
      inlineUrl="/photo.heic"
      downloadUrl="/download/photo.heic"
      thumbUrl="/thumb/photo.heic"
    />,
  );

  const img = screen.getByRole("img");
  expect(img.getAttribute("src")).toBe("/thumb/photo.heic");
  expect(img.getAttribute("alt")).toBe("photo.heic");
});
