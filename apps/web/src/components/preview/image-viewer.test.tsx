// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ImageViewer } from "./image-viewer";

const fetchHeicAsJpeg = vi.fn<(src: string, options: { signal?: AbortSignal }) => Promise<Blob>>();

vi.mock("@/lib/preview/heic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/preview/heic")>();
  return {
    ...actual,
    fetchHeicAsJpeg: (src: string, options: { signal?: AbortSignal }) =>
      fetchHeicAsJpeg(src, options),
  };
});

beforeEach(() => {
  fetchHeicAsJpeg.mockReset();
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:decoded"),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

it("shows a HEIC's thumbnail first and its decoded JPEG after zooming", async () => {
  fetchHeicAsJpeg.mockResolvedValue(new Blob(["jpeg"], { type: "image/jpeg" }));
  render(<ImageViewer src="/photo.heic" name="photo.heic" thumbUrl="/thumb" size={10} />);

  const img = screen.getByRole("img");
  expect(img.getAttribute("src")).toBe("/thumb");

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  });

  expect(fetchHeicAsJpeg).toHaveBeenCalledWith(
    "/photo.heic",
    expect.objectContaining({ size: 10, signal: expect.any(AbortSignal) }),
  );
  expect(screen.getByRole("img").getAttribute("src")).toBe("blob:decoded");
  expect(screen.getByRole("button", { name: "Zoom out" })).toBeTruthy();
});

it("keeps the thumbnail on screen and reports a failed decode in a pill", async () => {
  fetchHeicAsJpeg.mockRejectedValue(new Error("HEIC image exceeds 50 MiB decode limit"));
  render(<ImageViewer src="/photo.heic" name="photo.heic" thumbUrl="/thumb" />);

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  });

  expect(screen.getByRole("img").getAttribute("src")).toBe("/thumb");
  expect(screen.getByRole("status").textContent).toContain("exceeds 50 MiB");
  expect(screen.getByRole("button", { name: "Zoom in" })).toBeTruthy();
});

it("falls back to the unsupported card only when nothing can be shown", async () => {
  fetchHeicAsJpeg.mockRejectedValue(new Error("Decoder failed"));
  const onError = vi.fn();
  render(
    <ImageViewer
      src="/photo.heic"
      name="photo.heic"
      thumbUrl="/thumb"
      downloadUrl="/download"
      onError={onError}
    />,
  );

  await act(async () => {
    fireEvent.error(screen.getByRole("img"));
  });

  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByText("Decoder failed")).toBeTruthy();
  expect(screen.getByText("Download").closest("a")?.getAttribute("href")).toBe("/download");
  expect(onError).not.toHaveBeenCalled();
});

it("aborts an in-flight decode on unmount and never creates an object URL for it", async () => {
  const pending = deferred<Blob>();
  fetchHeicAsJpeg.mockImplementation((_src, options) => {
    options.signal?.addEventListener("abort", () => pending.reject(new Error("aborted")));
    return pending.promise;
  });
  const { unmount } = render(<ImageViewer src="/photo.heic" name="photo.heic" thumbUrl="/thumb" />);

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  });
  const signal = fetchHeicAsJpeg.mock.calls[0]?.[1].signal;
  unmount();

  expect(signal?.aborted).toBe(true);
  await act(async () => {
    pending.resolve(new Blob(["jpeg"]));
  });
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it("passes a plain image straight through and reports its load errors", () => {
  const onError = vi.fn();
  render(<ImageViewer src="/photo.png" name="photo.png" thumbUrl="/thumb" onError={onError} />);

  const img = screen.getByRole("img");
  expect(img.getAttribute("src")).toBe("/photo.png");
  fireEvent.error(img);
  expect(onError).toHaveBeenCalledTimes(1);
  expect(fetchHeicAsJpeg).not.toHaveBeenCalled();
});
