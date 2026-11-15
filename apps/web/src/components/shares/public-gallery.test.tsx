// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { type GalleryImage, PublicGallery } from "./public-gallery";

const images: GalleryImage[] = [
  { name: "a.png", path: "/a.png" },
  { name: "b.jpg", path: "/b.jpg" },
  { name: "c.gif", path: "/c.gif" },
];
const thumbUrl = (path: string, size: 256 | 1024) =>
  `/thumb?path=${encodeURIComponent(path)}&size=${size}`;
const downloadUrl = (path: string) => `/download?path=${encodeURIComponent(path)}`;
const opened = (path: string) => `${downloadUrl(path)}&preview=t`;
let previewUrl = vi.fn(async (path: string) => opened(path));

/** The gallery over `list`, opening previews through `previewUrl`. */
function gallery(list: GalleryImage[] = images) {
  return render(
    <PublicGallery
      images={list}
      thumbUrl={thumbUrl}
      downloadUrl={downloadUrl}
      previewUrl={previewUrl}
    />,
  );
}

afterEach(() => {
  cleanup();
  document.body.style.overflow = "";
  previewUrl = vi.fn(async (path: string) => opened(path));
});

it("shows an icon for a tile whose thumbnail 404s, never the original, leaving other tiles untouched", () => {
  gallery();
  const tileA = screen.getByRole("img", { name: "a.png" });
  const tileB = screen.getByRole("img", { name: "b.jpg" });
  expect(tileA.getAttribute("src")).toBe(thumbUrl("/a.png", 256));
  expect(tileA.getAttribute("loading")).toBe("lazy");
  expect(tileA.getAttribute("decoding")).toBe("async");
  fireEvent.error(tileA);
  expect(screen.queryByRole("img", { name: "a.png" })).toBeNull();
  expect(screen.getByRole("button", { name: "a.png" }).querySelector("svg")).not.toBeNull();
  expect(tileB.getAttribute("src")).toBe(thumbUrl("/b.jpg", 256));
  expect(previewUrl).not.toHaveBeenCalled();
});

it("opens each image's full size as one preview, however often the visitor steps back to it", async () => {
  gallery();
  fireEvent.click(screen.getByRole("button", { name: "a.png" }));
  await screen.findByRole("dialog");
  fireEvent.keyDown(window, { key: "ArrowRight" });
  await screen.findByText("2 / 3");
  fireEvent.keyDown(window, { key: "ArrowLeft" });
  await screen.findByText("1 / 3");
  fireEvent.keyDown(window, { key: "ArrowRight" });
  await screen.findByText("2 / 3");
  expect(previewUrl.mock.calls.map(([path]) => path)).toEqual(["/a.png", "/b.jpg"]);
});

it("never opens a camera raw file, which only ever shows its thumbnail", async () => {
  gallery([{ name: "shot.arw", path: "/shot.arw" }]);
  fireEvent.click(screen.getByRole("button", { name: "shot.arw" }));
  await screen.findByRole("dialog");
  expect(previewUrl).not.toHaveBeenCalled();
});

it("keeps the thumbnail and says why when the full size cannot be opened", async () => {
  previewUrl = vi.fn(async () => {
    throw new Error("Share download limit reached");
  });
  gallery();
  fireEvent.click(screen.getByRole("button", { name: "a.png" }));
  const lightbox = await screen.findByRole("dialog");
  expect(await screen.findByText("Share download limit reached")).toBeTruthy();
  expect(lightbox.querySelector("img")?.getAttribute("src")).toBe(thumbUrl("/a.png", 1024));
});

it("opens a full-page overlay, not a Base UI modal, and locks body scroll while open", async () => {
  gallery();
  expect(document.body.style.overflow).toBe("");
  fireEvent.click(screen.getByRole("img", { name: "a.png" }));
  const lightbox = await screen.findByRole("dialog");
  expect(lightbox.getAttribute("aria-modal")).toBe("true");
  expect(lightbox.className).toContain("fixed");
  expect(lightbox.className).toContain("inset-0");
  // A Base UI Dialog renders its own backdrop and popup wrapper; the full-page overlay is a
  // plain element with no such markers.
  expect(document.querySelector('[data-slot="dialog-backdrop"]')).toBeNull();
  expect(document.querySelector('[data-slot="dialog-popup"]')).toBeNull();
  expect(document.body.style.overflow).toBe("hidden");
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.body.style.overflow).toBe("");
});

it("navigates with the arrow keys and closes on Escape", async () => {
  gallery();
  fireEvent.click(screen.getByRole("img", { name: "a.png" }));
  await screen.findByRole("dialog");
  expect(screen.getByText("1 / 3")).toBeTruthy();
  fireEvent.keyDown(window, { key: "ArrowRight" });
  await screen.findByText("2 / 3");
  fireEvent.keyDown(window, { key: "ArrowLeft" });
  await screen.findByText("1 / 3");
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("hides the counter and prev/next controls for a single-image gallery", async () => {
  gallery([images[0] as GalleryImage]);
  fireEvent.click(screen.getByRole("img", { name: "a.png" }));
  await screen.findByRole("dialog");
  expect(screen.queryByRole("button", { name: "Previous" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
  expect(screen.queryByText(/\/ 1/)).toBeNull();
});

it("preloads the neighbours' cacheable 1024px thumbnails, never their full-size images", async () => {
  const created: string[] = [];
  class FakeImage {
    set src(value: string) {
      created.push(value);
    }
  }
  vi.stubGlobal("Image", FakeImage);
  gallery();
  fireEvent.click(screen.getByRole("img", { name: "a.png" }));
  await screen.findByRole("dialog");
  expect(created).toContain(thumbUrl("/c.gif", 1024));
  expect(created).toContain(thumbUrl("/b.jpg", 1024));
  // Each full-size image is a counted preview, so only the open image's own loads.
  await waitFor(() =>
    expect(created.filter((url) => url.startsWith("/download"))).toEqual([opened("/a.png")]),
  );
  created.length = 0;
  fireEvent.keyDown(window, { key: "ArrowRight" });
  await screen.findByText("2 / 3");
  expect(created).toContain(thumbUrl("/a.png", 1024));
  expect(created).toContain(thumbUrl("/c.gif", 1024));
  vi.unstubAllGlobals();
});

it("the per-image download uses the full-size URL, and the header lists the current file name", async () => {
  gallery();
  fireEvent.click(screen.getByRole("img", { name: "b.jpg" }));
  const lightbox = await screen.findByRole("dialog");
  expect(lightbox.textContent).toContain("b.jpg");
  const download = screen.getByRole("link", { name: "Download" });
  expect(download.getAttribute("href")).toBe(downloadUrl("/b.jpg"));
});
