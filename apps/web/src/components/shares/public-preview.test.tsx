// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PublicPreview } from "./public-preview";

const fetchPreview = vi.hoisted(() => vi.fn());
vi.mock("@/lib/shares/preview", () => ({ fetchPublicPreview: fetchPreview }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  fetchPreview.mockReset();
});
it("escapes active markup and suppresses markdown tracking images and links", async () => {
  fetchPreview.mockResolvedValue(
    '# Safe heading\n<script>alert("unsafe")</script>\n![tracker](https://example.invalid/pixel)\n[offsite](https://example.invalid)',
  );
  const close = vi.fn();
  render(<PublicPreview url="/public/file" name="notes.md" kind="markdown" onClose={close} />);
  await screen.findByRole("heading", { name: "Safe heading" });
  const region = screen.getByRole("region", { name: "Preview of notes.md" });
  expect(region.querySelector("script,img,a")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
  expect(close).toHaveBeenCalledOnce();
});
it("revokes PDF object URLs on close and drops late bytes after unmount", async () => {
  const create = vi.fn().mockReturnValue("blob:safe");
  const revoke = vi.fn();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: create });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
  fetchPreview.mockResolvedValue(new Blob(["%PDF-"], { type: "application/pdf" }));
  const view = render(
    <PublicPreview url="/public/pdf" name="report.pdf" kind="pdf" onClose={vi.fn()} />,
  );
  await waitFor(() =>
    expect(screen.getByTitle("report.pdf").getAttribute("src")).toBe("blob:safe"),
  );
  view.unmount();
  expect(revoke).toHaveBeenCalledWith("blob:safe");
  let resolve: (text: string) => void = () => {};
  fetchPreview.mockImplementation((_url: string, _kind: string, signal: AbortSignal) => {
    expect(signal.aborted).toBe(false);
    return new Promise<string>((done) => {
      resolve = done;
    });
  });
  const pending = render(
    <PublicPreview url="/public/text" name="a.txt" kind="text" onClose={vi.fn()} />,
  );
  pending.unmount();
  await act(async () => resolve("stale secret"));
  expect(screen.queryByText("stale secret")).toBeNull();
});
it("uses native media URLs and reports media/read failures", async () => {
  const image = render(
    <PublicPreview url="/public/image" name="a.png" kind="image" onClose={vi.fn()} />,
  );
  expect(screen.getByRole("img").getAttribute("src")).toBe("/public/image");
  fireEvent.error(screen.getByRole("img"));
  expect(screen.getByText(/Could not preview this file/)).toBeTruthy();
  image.unmount();
  fetchPreview.mockRejectedValue(new Error("Wrong password"));
  render(<PublicPreview url="/public/file" name="a.txt" kind="text" onClose={vi.fn()} />);
  expect(await screen.findByText("Wrong password")).toBeTruthy();
});
