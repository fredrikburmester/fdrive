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

function videoEntry(name: string): FsEntry {
  return {
    name,
    path: `/films/${name}`,
    kind: "file",
    ext: name.slice(name.lastIndexOf(".")).toLowerCase(),
    mime: null,
    size: 1000,
    modifiedAt: "2026-11-14T00:00:00Z",
  };
}

it("plays mp4 from the inline URL and offers the subtitle files next to it", () => {
  const { container } = render(
    <PreviewViewer
      entry={videoEntry("Movie.mp4")}
      inlineUrl="/inline/Movie.mp4"
      downloadUrl="/download"
      folderEntries={[videoEntry("Movie.mp4"), videoEntry("Movie.en.srt")]}
    />,
  );

  expect(container.querySelector("video")?.getAttribute("src")).toBe("/inline/Movie.mp4");
  const track = container.querySelector('track[kind="subtitles"]');
  expect(track?.getAttribute("label")).toBe("en");
  expect(track?.getAttribute("src")).toBe("/api/v1/fs/subtitles?path=%2Ffilms%2FMovie.en.srt");
});

it("plays other video through the API's transcode", () => {
  const { container } = render(
    <PreviewViewer entry={videoEntry("Movie.mkv")} inlineUrl="/inline" downloadUrl="/download" />,
  );

  expect(container.querySelector("video")?.getAttribute("src")).toBe(
    "/api/v1/fs/transcode?path=%2Ffilms%2FMovie.mkv",
  );
  expect(container.querySelector('track[kind="subtitles"]')).toBeNull();
});
