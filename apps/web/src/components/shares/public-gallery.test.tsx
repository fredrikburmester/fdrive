// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { type GalleryImage, PublicGallery } from "./public-gallery";

const images: GalleryImage[] = [
  { name: "a.png", path: "/a.png" },
  { name: "b.jpg", path: "/b.jpg" },
  { name: "c.gif", path: "/c.gif" },
];
const thumbUrl = (path: string) => `/thumb?path=${encodeURIComponent(path)}`;
const downloadUrl = (path: string) => `/download?path=${encodeURIComponent(path)}`;

afterEach(() => {
  cleanup();
  document.body.style.overflow = "";
});

it("falls back a single tile to the download URL when its thumbnail 404s, leaving other tiles untouched", () => {
  render(<PublicGallery images={images} thumbUrl={thumbUrl} downloadUrl={downloadUrl} />);
  const tileA = screen.getByRole("img", { name: "a.png" });
  const tileB = screen.getByRole("img", { name: "b.jpg" });
  expect(tileA.getAttribute("src")).toBe(thumbUrl("/a.png"));
  expect(tileA.getAttribute("loading")).toBe("lazy");
  expect(tileA.getAttribute("decoding")).toBe("async");
  fireEvent.error(tileA);
  expect(tileA.getAttribute("src")).toBe(downloadUrl("/a.png"));
  expect(tileB.getAttribute("src")).toBe(thumbUrl("/b.jpg"));
});

it("opens a full-page overlay, not a Base UI modal, and locks body scroll while open", async () => {
  render(<PublicGallery images={images} thumbUrl={thumbUrl} downloadUrl={downloadUrl} />);
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
  render(<PublicGallery images={images} thumbUrl={thumbUrl} downloadUrl={downloadUrl} />);
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
  render(
    <PublicGallery
      images={[images[0] as GalleryImage]}
      thumbUrl={thumbUrl}
      downloadUrl={downloadUrl}
    />,
  );
  fireEvent.click(screen.getByRole("img", { name: "a.png" }));
  await screen.findByRole("dialog");
  expect(screen.queryByRole("button", { name: "Previous" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
  expect(screen.queryByText(/\/ 1/)).toBeNull();
});

it("preloads the neighbouring full-size images as the open index changes", async () => {
  const created: string[] = [];
  class FakeImage {
    set src(value: string) {
      created.push(value);
    }
  }
  vi.stubGlobal("Image", FakeImage);
  render(<PublicGallery images={images} thumbUrl={thumbUrl} downloadUrl={downloadUrl} />);
  fireEvent.click(screen.getByRole("img", { name: "a.png" }));
  await screen.findByRole("dialog");
  expect(created).toContain(downloadUrl("/c.gif"));
  expect(created).toContain(downloadUrl("/b.jpg"));
  created.length = 0;
  fireEvent.keyDown(window, { key: "ArrowRight" });
  await screen.findByText("2 / 3");
  expect(created).toContain(downloadUrl("/a.png"));
  expect(created).toContain(downloadUrl("/c.gif"));
  vi.unstubAllGlobals();
});

it("the per-image download uses the full-size URL, and the header lists the current file name", async () => {
  render(<PublicGallery images={images} thumbUrl={thumbUrl} downloadUrl={downloadUrl} />);
  fireEvent.click(screen.getByRole("img", { name: "b.jpg" }));
  const lightbox = await screen.findByRole("dialog");
  expect(lightbox.textContent).toContain("b.jpg");
  const download = screen.getByRole("link", { name: "Download" });
  expect(download.getAttribute("href")).toBe(downloadUrl("/b.jpg"));
});
