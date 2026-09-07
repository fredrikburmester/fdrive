// @vitest-environment jsdom
import type { PublicShare } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PublicSharePage } from "./public-share-page";

const calls = vi.hoisted(() => ({ metadata: vi.fn(), password: vi.fn(), entries: vi.fn() }));
vi.mock("@/lib/shares/client", () => ({
  publicShareClient: () => ({
    publicShare: calls.metadata,
    setSharePassword: calls.password,
    shareEntries: calls.entries,
    shareDownloadUrl: (id: string, path = "/") =>
      `/api/v1/public/shares/${id}/download?path=${encodeURIComponent(path)}`,
    shareThumbUrl: (id: string, path: string, size: number) =>
      `/api/v1/public/shares/${id}/thumb?path=${encodeURIComponent(path)}&size=${size}`,
    shareArchiveUrl: (id: string) => `/api/v1/public/shares/${id}/archive`,
  }),
}));
const id = "00000000-0000-4000-8000-000000000001";
const metadata: PublicShare = {
  name: "Shared document",
  description: "",
  scope: "read",
  layout: "single-file",
  presentation: "auto",
  fileName: "document.docx",
  hasPassword: true,
  credentialPresent: false,
  expiresAt: null,
  maxDownloads: 0,
  usedDownloads: 0,
  unavailableReason: null,
};
function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <PublicSharePage id={id} path="/" />
    </QueryClientProvider>,
  );
  return { queryClient, ...view };
}
beforeEach(() => {
  calls.metadata.mockResolvedValue(metadata);
  calls.password.mockResolvedValue({ ok: true });
  calls.entries.mockResolvedValue({ items: [] });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it("stores supplied password without claiming verification or probing file downloads; Office stays download-only", async () => {
  const { queryClient } = setup();
  await screen.findByText("Shared document");
  expect(screen.queryByRole("link", { name: "Download" })).toBeNull();
  calls.metadata.mockResolvedValue({ ...metadata, credentialPresent: true });
  fireEvent.change(screen.getByLabelText("Share password"), { target: { value: "wrong-input" } });
  fireEvent.click(screen.getByRole("button", { name: "Use password" }));
  await screen.findByRole("link", { name: "Download" });
  expect(calls.password).toHaveBeenCalledWith(id, "wrong-input");
  expect(calls.entries).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
  expect(screen.queryByText(/verified|unlocked|accepted/i)).toBeNull();
  expect((screen.getByLabelText("Share password") as HTMLInputElement).value).toBe("");
  expect(
    JSON.stringify(
      queryClient
        .getQueryCache()
        .getAll()
        .map((query) => query.state.data),
    ),
  ).not.toContain("wrong-input");
  expect(queryClient.getMutationCache().getAll()).toEqual([]);
});
it("clears old directory entries during credential replacement and ignores late old results", async () => {
  calls.metadata.mockResolvedValue({
    ...metadata,
    credentialPresent: true,
    layout: "directory",
    fileName: null,
  });
  calls.entries.mockResolvedValue({
    items: [{ name: "old-secret.txt", kind: "file", size: 1, modifiedAt: "2026-01-01T00:00:00Z" }],
  });
  const { queryClient } = setup();
  await screen.findByText("old-secret.txt");
  let resolve: (value: unknown) => void = () => {};
  calls.password.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  calls.entries.mockRejectedValue(new Error("Wrong password"));
  fireEvent.change(screen.getByLabelText("Share password"), { target: { value: "replacement" } });
  fireEvent.click(screen.getByRole("button", { name: "Use password" }));
  await waitFor(() => expect(screen.queryByText("old-secret.txt")).toBeNull());
  expect(
    queryClient.getQueryCache().findAll({ predicate: (query) => query.queryKey[3] === "entries" }),
  ).toHaveLength(0);
  await act(async () => resolve({ ok: true }));
  await screen.findByText("Wrong password");
  expect(screen.queryByText("old-secret.txt")).toBeNull();
  expect(queryClient.getQueryData(["public-share", id, 0, "entries", "/"])).toBeUndefined();
});
it("write-only and archive pages never list owner contents", async () => {
  calls.metadata.mockResolvedValue({
    ...metadata,
    hasPassword: false,
    scope: "write",
    layout: "directory",
    fileName: null,
  });
  const write = setup();
  await screen.findByRole("button", { name: "Choose files" });
  expect(calls.entries).not.toHaveBeenCalled();
  expect(screen.queryByRole("link", { name: /Download/ })).toBeNull();
  write.unmount();
  calls.metadata.mockResolvedValue({
    ...metadata,
    hasPassword: false,
    layout: "archive",
    fileName: null,
  });
  setup();
  await screen.findByRole("link", { name: "Download ZIP" });
  expect(calls.entries).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
});
it("a folder of only images renders a gallery whose lightbox navigates and downloads the current image", async () => {
  calls.metadata.mockResolvedValue({
    ...metadata,
    hasPassword: false,
    layout: "directory",
    fileName: null,
  });
  calls.entries.mockResolvedValue({
    items: [
      { name: "a.png", kind: "file", size: 1, modifiedAt: "2026-01-01T00:00:00Z" },
      { name: "b.jpg", kind: "file", size: 1, modifiedAt: "2026-01-01T00:00:00Z" },
    ],
  });
  setup();
  await screen.findByRole("img", { name: "a.png" });
  expect(screen.getByRole("img", { name: "a.png" }).getAttribute("loading")).toBe("lazy");
  expect(screen.queryByRole("table")).toBeNull();
  fireEvent.click(screen.getByRole("img", { name: "a.png" }));
  const lightbox = await screen.findByRole("dialog");
  expect(lightbox.getAttribute("aria-modal")).toBe("true");
  expect(screen.getAllByRole("link", { name: "Download" })).toHaveLength(1);
  expect(screen.getByText("1 / 2")).toBeTruthy();
  fireEvent.keyDown(window, { key: "ArrowRight" });
  await screen.findByText("b.jpg");
  expect(screen.getByText("2 / 2")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
it("a single image file resolves to a one-image gallery without a download list", async () => {
  calls.metadata.mockResolvedValue({ ...metadata, hasPassword: false, fileName: "photo.png" });
  setup();
  await screen.findByRole("img", { name: "photo.png" });
  expect(screen.queryByRole("link", { name: "Download" })).toBeNull();
});
