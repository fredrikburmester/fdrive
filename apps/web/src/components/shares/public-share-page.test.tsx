// @vitest-environment jsdom
import type { PublicShare } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PublicSharePage } from "./public-share-page";

const calls = vi.hoisted(() => ({
  metadata: vi.fn(),
  password: vi.fn(),
  entries: vi.fn(),
  archiveEntries: vi.fn(),
  preview: vi.fn(),
}));
vi.mock("@/lib/shares/client", () => ({
  publicShareClient: () => ({
    publicShare: calls.metadata,
    setSharePassword: calls.password,
    shareEntries: calls.entries,
    shareArchiveEntries: calls.archiveEntries,
    sharePreview: calls.preview,
    shareDownloadUrl: (id: string, path = "/", preview?: string) =>
      `/api/v1/public/shares/${id}/download?path=${encodeURIComponent(path)}${preview === undefined ? "" : `&preview=${preview}`}`,
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
  calls.archiveEntries.mockResolvedValue({
    format: "zip",
    entries: [{ path: "a.txt", kind: "file", size: 10, modifiedAt: null }],
    truncated: false,
  });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it("says an accepted password was accepted without probing file downloads; Office stays download-only", async () => {
  const { queryClient } = setup();
  await screen.findByText("Shared document");
  expect(screen.getByText("Enter the password supplied with this link.")).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Download" })).toBeNull();
  calls.metadata.mockResolvedValue({ ...metadata, credentialPresent: true });
  fireEvent.change(screen.getByLabelText("Share password"), { target: { value: "wrong-input" } });
  fireEvent.click(screen.getByRole("button", { name: "Use password" }));
  await screen.findByRole("link", { name: "Download" });
  expect(calls.password).toHaveBeenCalledWith(id, "wrong-input");
  expect(calls.entries).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
  expect(screen.getByText("Password accepted. Enter another to replace it.")).toBeTruthy();
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
it("a directory shows Peek beside Download only for archive rows, and peeking opens the shared entries view", async () => {
  calls.metadata.mockResolvedValue({
    ...metadata,
    hasPassword: false,
    layout: "directory",
    fileName: null,
  });
  calls.entries.mockResolvedValue({
    items: [
      { name: "notes.txt", kind: "file", size: 5, modifiedAt: "2026-01-01T00:00:00Z" },
      { name: "bundle.zip", kind: "file", size: 100, modifiedAt: "2026-01-01T00:00:00Z" },
    ],
  });
  setup();
  await screen.findByText("bundle.zip");
  expect(screen.getAllByRole("button", { name: "Peek" })).toHaveLength(1);
  const rows = screen.getAllByRole("row");
  const notesRow = rows.find((row) => row.textContent?.includes("notes.txt"));
  const bundleRow = rows.find((row) => row.textContent?.includes("bundle.zip"));
  expect(
    notesRow
      ? Array.from(notesRow.querySelectorAll("button")).some((b) => b.textContent === "Peek")
      : true,
  ).toBe(false);
  expect(
    bundleRow
      ? Array.from(bundleRow.querySelectorAll("button")).some((b) => b.textContent === "Peek")
      : false,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Peek" }));
  await screen.findByRole("region", { name: "Archive entries for bundle.zip" });
  await screen.findByText("a.txt");
  expect(calls.archiveEntries).toHaveBeenCalledWith(id, "/bundle.zip");
});
it("previews and peeks a download-limited link, opening streamed media through the share", async () => {
  calls.metadata.mockResolvedValue({
    ...metadata,
    hasPassword: false,
    layout: "directory",
    presentation: "list",
    fileName: null,
    maxDownloads: 1,
  });
  calls.entries.mockResolvedValue({
    items: [
      { name: "notes.txt", kind: "file", size: 5, modifiedAt: "2026-01-01T00:00:00Z" },
      { name: "song.mp3", kind: "file", size: 5, modifiedAt: "2026-01-01T00:00:00Z" },
      { name: "bundle.zip", kind: "file", size: 100, modifiedAt: "2026-01-01T00:00:00Z" },
    ],
  });
  calls.preview.mockResolvedValue({ token: "opened" });
  const fetched = vi.fn(async (_url: string) => new Response("hello"));
  vi.stubGlobal("fetch", fetched);
  try {
    const directory = setup();
    await screen.findByText("notes.txt");
    expect(screen.getByRole("button", { name: "Peek" })).toBeTruthy();
    const row = (name: string) => screen.getByText(name).closest("tr") as HTMLElement;
    // Text is one plain download, counted as it is.
    fireEvent.click(within(row("notes.txt")).getByRole("button", { name: "Preview" }));
    const text = await screen.findByRole("region", { name: "Preview of notes.txt" });
    await within(text).findByText("hello");
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(fetched.mock.calls[0]?.[0]).toBe(
      `/api/v1/public/shares/${id}/download?path=%2Fnotes.txt`,
    );
    expect(calls.preview).not.toHaveBeenCalled();
    // Audio streams in Range reads, so it is opened through the share once, then read with it.
    fireEvent.click(within(row("song.mp3")).getByRole("button", { name: "Preview" }));
    const audio = await screen.findByRole("region", { name: "Preview of song.mp3" });
    await waitFor(() =>
      expect(audio.querySelector("audio")?.getAttribute("src")).toBe(
        `/api/v1/public/shares/${id}/download?path=%2Fsong.mp3&preview=opened`,
      ),
    );
    expect(calls.preview).toHaveBeenCalledTimes(1);
    expect(calls.preview).toHaveBeenCalledWith(id, "/song.mp3");
    directory.unmount();

    calls.metadata.mockResolvedValue({
      ...metadata,
      hasPassword: false,
      fileName: "notes.txt",
      maxDownloads: 1,
    });
    setup();
    await screen.findByText("notes.txt");
    expect(screen.getByRole("button", { name: "Preview" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Download" })).toBeTruthy();
  } finally {
    vi.unstubAllGlobals();
  }
});
it("says why a preview could not be opened, and fetches nothing", async () => {
  calls.metadata.mockResolvedValue({
    ...metadata,
    hasPassword: false,
    fileName: "song.mp3",
    maxDownloads: 1,
  });
  calls.preview.mockRejectedValue(new Error("Share download limit reached"));
  const fetched = vi.fn(async () => new Response("hello"));
  vi.stubGlobal("fetch", fetched);
  try {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Preview" }));
    const preview = await screen.findByRole("region", { name: "Preview of song.mp3" });
    await within(preview).findByText("Share download limit reached");
    expect(preview.querySelector("audio")).toBeNull();
    expect(fetched).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
it("a single-file archive share shows Peek beside its download button", async () => {
  calls.metadata.mockResolvedValue({
    ...metadata,
    hasPassword: false,
    layout: "single-file",
    fileName: "bundle.tar.gz",
  });
  setup();
  await screen.findByRole("button", { name: "Peek" });
  fireEvent.click(screen.getByRole("button", { name: "Peek" }));
  await screen.findByRole("region", { name: "Archive entries for bundle.tar.gz" });
  expect(calls.archiveEntries).toHaveBeenCalledWith(id, "/");
});

it("shows the server's refusal of a wrong password and keeps the files hidden", async () => {
  calls.password.mockRejectedValue(new Error("Share password required or incorrect"));
  setup();
  await screen.findByText("Shared document");
  fireEvent.change(screen.getByLabelText("Share password"), { target: { value: "nope" } });
  fireEvent.click(screen.getByRole("button", { name: "Use password" }));
  await screen.findByText("Share password required or incorrect");
  expect(screen.getByText("Enter the password supplied with this link.")).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Download" })).toBeNull();
});

it("names a withheld share generically and reports a password the server did not verify", async () => {
  calls.metadata.mockResolvedValue({ ...metadata, name: "", fileName: null });
  setup();
  await screen.findByText("Password-protected share");
  fireEvent.change(screen.getByLabelText("Share password"), { target: { value: "nope" } });
  fireEvent.click(screen.getByRole("button", { name: "Use password" }));
  await screen.findByText("Share password incorrect.");
  expect(calls.entries).not.toHaveBeenCalled();
});
it("shows a symbolic link in a shared folder by name only, with nothing to open", async () => {
  calls.metadata.mockResolvedValue({
    ...metadata,
    hasPassword: false,
    layout: "directory",
    presentation: "list",
    fileName: null,
  });
  calls.entries.mockResolvedValue({
    items: [
      { name: "bin", kind: "symlink", size: 0, modifiedAt: "2026-01-01T00:00:00Z" },
      { name: "notes.txt", kind: "file", size: 5, modifiedAt: "2026-01-01T00:00:00Z" },
    ],
  });
  setup();
  const row = (await screen.findByText("bin")).closest("tr");
  expect(row?.getAttribute("aria-disabled")).toBe("true");
  expect(row?.querySelector("a, button")).toBeNull();
  expect(row?.textContent).not.toContain("bytes");
  const file = screen.getByText("notes.txt").closest("tr");
  expect(file?.querySelector("a")).not.toBeNull();
});
