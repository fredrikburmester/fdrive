// @vitest-environment jsdom
import type { EncryptedFolderInfo, TrashEntry } from "@fdrive/contracts";
import * as crypto from "@fdrive/crypto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "@/lib/api/client";
import { keyStore } from "@/lib/encryption/keys";
import { TrashPage } from "./trash-page";

const report: TrashEntry = {
  id: "trash-1",
  name: "report.txt",
  originalPath: "/docs/report.txt",
  size: 12,
  deletedAt: "2026-01-01T00:00:00Z",
};

const fixtures = vi.hoisted(() => ({
  entries: [] as TrashEntry[],
  truncated: false,
  loading: false,
  error: null as Error | null,
  refetch: vi.fn(),
  restore: vi.fn(),
  restorePending: false,
  restoreConflict: false,
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  retentionDays: 30 as number | undefined,
}));

vi.mock("sonner", () => ({
  toast: { success: fixtures.toastSuccess, error: fixtures.toastError },
}));
vi.mock("@/components/shell/page-header", () => ({ PageHeader: () => null }));
vi.mock("@/components/files/destination-picker", () => ({
  DestinationPicker: (props: {
    open: boolean;
    pending?: boolean;
    onConfirm: (folder: string) => void;
  }) =>
    props.open ? (
      <div role="dialog" aria-label="Restore to">
        <button
          type="button"
          disabled={props.pending}
          onClick={() => props.onConfirm("/elsewhere")}
        >
          {props.pending ? "Restoring…" : "Restore here"}
        </button>
      </div>
    ) : null,
}));
vi.mock("@/lib/api/trash-settings-queries", () => ({
  useTrashSettings: () => ({
    data:
      fixtures.retentionDays === undefined ? undefined : { retentionDays: fixtures.retentionDays },
  }),
}));
vi.mock("@/lib/trash/queries", () => ({
  isRestoreConflict: () => fixtures.restoreConflict,
  useTrash: () => ({
    data:
      fixtures.loading || fixtures.error !== null
        ? undefined
        : { entries: fixtures.entries, truncated: fixtures.truncated },
    isLoading: fixtures.loading,
    isError: fixtures.error !== null,
    error: fixtures.error,
    refetch: fixtures.refetch,
  }),
  useTrashRestore: () => ({ mutate: fixtures.restore, isPending: fixtures.restorePending }),
  useTrashPurge: () => ({ mutate: vi.fn(), isPending: false }),
  useTrashEmpty: () => ({ mutate: vi.fn(), isPending: false }),
}));

type RestoreCallbacks = {
  onSuccess: () => void;
  onError: (error: Error) => void;
  onSettled?: () => void;
};

function lastRestoreCallbacks(): RestoreCallbacks {
  const callbacks = fixtures.restore.mock.lastCall?.[1] as RestoreCallbacks | undefined;
  if (callbacks === undefined) {
    throw new Error("restore was not called");
  }
  return callbacks;
}

let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function renderPage() {
  return render(<TrashPage />, { wrapper });
}

/**
 * The page folds its columns on a phone through `useIsMobile`, which reads `window.matchMedia`
 * (jsdom does not implement it) and decides from `window.innerWidth`.
 */
function stubViewport(width: number) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: width < 768,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  stubViewport(1024);
  fixtures.entries = [report];
  fixtures.truncated = false;
  fixtures.loading = false;
  fixtures.error = null;
  fixtures.restorePending = false;
  fixtures.restoreConflict = false;
  fixtures.retentionDays = 30;
});

afterEach(() => {
  cleanup();
  fixtures.refetch.mockClear();
  fixtures.restore.mockClear();
  fixtures.toastSuccess.mockClear();
  fixtures.toastError.mockClear();
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("says when Trash deletes what it holds, once that setting has loaded", () => {
  const view = renderPage();
  expect(screen.getByText("Items in Trash are deleted permanently after 30 days.")).toBeTruthy();
  view.unmount();

  fixtures.retentionDays = undefined;
  renderPage();
  expect(screen.queryByText(/Items in Trash are deleted permanently/)).toBeNull();
});

it("lists each item as a row with its original folder, size and deletion date", () => {
  fixtures.entries = [
    report,
    { ...report, id: "trash-3", name: "top.txt", originalPath: "/top.txt", size: 30 },
  ];
  renderPage();

  expect(document.querySelector('[data-slot="trash-list"]')).not.toBeNull();
  for (const column of ["Name", "Original folder", "Size", "Deleted"]) {
    expect(screen.getByRole("columnheader", { name: column })).toBeDefined();
  }
  const row = screen.getByRole("row", { name: /report\.txt/ });
  expect(row.textContent).toContain("/docs");
  expect(row.textContent).toContain("12 B");
  expect(screen.getByRole("row", { name: /top\.txt/ }).textContent).toContain("Home");
  // The bar under the header sums up what Trash holds.
  expect(screen.getByText("2 items")).toBeDefined();
  expect(screen.getByText("42 B")).toBeDefined();
});

it("keeps the same rows in the tree view, which Trash has no folders to nest", () => {
  window.localStorage.setItem("fdrive.view", JSON.stringify("tree"));
  renderPage();
  expect(document.querySelector('[data-slot="trash-tree"]')).not.toBeNull();
  expect(screen.getByRole("checkbox", { name: "Select report.txt" })).toBeDefined();
});

it("selects every row from the header, counts the selection and marks the rows", () => {
  renderPage();
  const row = screen.getByRole("row", { name: /report\.txt/ });
  expect(row.getAttribute("data-state")).toBeNull();
  expect(screen.getByRole("button", { name: "Delete permanently" })).toHaveProperty(
    "disabled",
    true,
  );

  fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
  expect(screen.getByText("1 selected")).toBeDefined();
  expect(row.getAttribute("data-state")).toBe("selected");
  expect(screen.getByRole("button", { name: "Delete permanently" })).toHaveProperty(
    "disabled",
    false,
  );

  fireEvent.click(screen.getByRole("checkbox", { name: "Deselect all" }));
  expect(screen.getByText("1 item")).toBeDefined();
  expect(row.getAttribute("data-state")).toBeNull();
});

it("folds the folder, size and date under the name on a phone", () => {
  stubViewport(390);
  renderPage();

  expect(screen.getByRole("columnheader", { name: "Name" })).toBeDefined();
  expect(screen.queryByRole("columnheader", { name: "Original folder" })).toBeNull();
  expect(screen.queryByRole("columnheader", { name: "Size" })).toBeNull();
  expect(screen.getByText("report.txt")).toBeDefined();
  expect(screen.getByText(/^\/docs · 12 B · /)).toBeDefined();
  expect(screen.getByRole("checkbox", { name: "Select report.txt" })).toBeDefined();
});

it("says Trash is empty, with nothing to act on", () => {
  fixtures.entries = [];
  renderPage();

  expect(screen.getByText("Trash is empty")).toBeDefined();
  expect(screen.getByText("0 items")).toBeDefined();
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.getByRole("button", { name: "Empty Trash" })).toHaveProperty("disabled", true);
});

it("shows placeholder rows while Trash loads", () => {
  fixtures.loading = true;
  renderPage();

  expect(screen.getByRole("status").textContent).toBe("Loading Trash…");
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.queryByText("Trash is empty")).toBeNull();
});

it("offers a retry when Trash fails to load", () => {
  fixtures.error = new Error("offline");
  renderPage();

  expect(screen.getByText("Could not load Trash")).toBeDefined();
  expect(screen.getByText("Could not load the trash.")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(fixtures.refetch).toHaveBeenCalledTimes(1);
});

it("says when the listing stops short of everything in Trash", () => {
  fixtures.truncated = true;
  renderPage();
  expect(screen.getByText("Showing the first 1 items.")).toBeDefined();
});

function selectReport() {
  fireEvent.click(screen.getByRole("checkbox", { name: "Select report.txt" }));
}

it("uses the global grid default and restores the selected trash item", () => {
  window.localStorage.setItem("fdrive.view", JSON.stringify("grid"));
  renderPage();

  expect(document.querySelector('[data-slot="trash-grid"]')).not.toBeNull();
  expect(screen.queryByRole("table")).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
  expect(screen.getByText("1 selected")).toBeDefined();
  expect(screen.getByRole("checkbox", { name: "Deselect all" })).toBeDefined();
  selectReport();
  selectReport();
  const restore = screen.getByRole("button", { name: "Restore" });
  expect(restore).not.toHaveProperty("disabled", true);
  expect(restore.getAttribute("aria-busy")).not.toBe("true");
  fireEvent.click(restore);
  expect(fixtures.restore).toHaveBeenCalledWith(
    { ids: ["trash-1"] },
    expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
  );
});

it("shows a busy indicator on Restore while a toolbar restore is in flight", () => {
  const view = renderPage();
  selectReport();
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  fixtures.restorePending = true;
  view.rerender(<TrashPage />);

  const busy = screen.getByRole("button", { name: "Restoring…" });
  expect(busy.hasAttribute("disabled")).toBe(true);
  expect(busy.getAttribute("aria-busy")).toBe("true");
  expect(busy.querySelector("svg.animate-spin")).not.toBeNull();
  expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
  expect(screen.getByRole("button", { name: "Restore to" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(busy);
  expect(fixtures.restore).toHaveBeenCalledTimes(1);

  fixtures.restorePending = false;
  view.rerender(<TrashPage />);
  expect(screen.getByRole("button", { name: "Restore" }).getAttribute("aria-busy")).not.toBe(
    "true",
  );
});

it("keeps the Restore to picker open, busy, until the restore succeeds", () => {
  const view = renderPage();
  selectReport();
  fireEvent.click(screen.getByRole("button", { name: "Restore to" }));
  const dialog = screen.getByRole("dialog", { name: "Restore to" });
  fireEvent.click(screen.getByRole("button", { name: "Restore here" }));
  expect(fixtures.restore).toHaveBeenCalledWith(
    { ids: ["trash-1"], target: "/elsewhere/report.txt" },
    expect.objectContaining({ onSettled: expect.any(Function) }),
  );

  fixtures.restorePending = true;
  view.rerender(<TrashPage />);
  expect(screen.getByRole("dialog", { name: "Restore to" })).toBe(dialog);
  expect(screen.getByRole("button", { name: "Restoring…" }).hasAttribute("disabled")).toBe(true);
  // The toolbar is disabled but does not claim the busy state for itself.
  const toolbarRestore = screen.getByRole("button", { name: "Restore" });
  expect(toolbarRestore.hasAttribute("disabled")).toBe(true);
  expect(toolbarRestore.getAttribute("aria-busy")).not.toBe("true");

  const callbacks = lastRestoreCallbacks();
  fixtures.restorePending = false;
  callbacks.onSuccess();
  callbacks.onSettled?.();
  view.rerender(<TrashPage />);
  expect(screen.queryByRole("dialog", { name: "Restore to" })).toBeNull();
  expect(fixtures.toastSuccess).toHaveBeenCalledWith("Restored 1 item.");
});

it("closes the Restore to picker on a conflict and offers it again from the toast", () => {
  fixtures.restoreConflict = true;
  const view = renderPage();
  selectReport();
  fireEvent.click(screen.getByRole("button", { name: "Restore to" }));
  fireEvent.click(screen.getByRole("button", { name: "Restore here" }));

  const callbacks = lastRestoreCallbacks();
  callbacks.onError(new Error("conflict"));
  callbacks.onSettled?.();
  view.rerender(<TrashPage />);
  expect(screen.queryByRole("dialog", { name: "Restore to" })).toBeNull();
  expect(fixtures.toastError).toHaveBeenCalledWith(
    'Could not restore "report.txt": a file already exists at that location.',
    expect.objectContaining({ action: expect.objectContaining({ label: "Restore to" }) }),
  );

  const action = fixtures.toastError.mock.lastCall?.[1].action as { onClick: () => void };
  action.onClick();
  view.rerender(<TrashPage />);
  expect(screen.getByRole("dialog", { name: "Restore to" })).toBeDefined();
});

describe("items from inside an encrypted folder", () => {
  async function encryptedTrash() {
    const account = await crypto.newKeyPair();
    const { marker, folder } = await crypto.createFolder(account.identity);
    const receipts = await crypto.encryptName("Receipts", folder.nameKey, folder.id);
    const taxes = await crypto.encryptName("Taxes 2026.pdf", folder.nameKey, folder.id);
    const parent = `/Private/${receipts}`;
    const entry: TrashEntry = {
      id: "trash-2",
      name: taxes,
      originalPath: `${parent}/${taxes}`,
      size: 2048,
      deletedAt: "2026-01-02T00:00:00Z",
    };
    const info: EncryptedFolderInfo = { path: "/Private", marker };
    vi.spyOn(apiClient, "encryptionStatus").mockResolvedValue({
      enabled: true,
      recipient: account.recipient,
      passwordKey: "AAAA",
      recoveryKey: "AAAA",
      devices: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    fixtures.entries = [report, entry];
    return { account, entry, parent, info, taxes };
  }

  beforeEach(async () => {
    await keyStore.lock();
    await keyStore.refresh({ enabled: false });
  });

  it("shows decrypted names once this browser holds the key, and restores by id", async () => {
    const { account, entry, parent, info, taxes } = await encryptedTrash();
    const lookup = vi.spyOn(apiClient, "encryptedFolder").mockResolvedValue({ folder: info });
    await keyStore.unlocked(account.identity);
    renderPage();

    expect(await screen.findByText("Taxes 2026.pdf")).toBeDefined();
    expect(screen.getByText("/Private/Receipts")).toBeDefined();
    expect(screen.queryByText(taxes)).toBeNull();
    expect(lookup).toHaveBeenCalledWith(parent);
    expect(lookup).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("checkbox", { name: "Select Taxes 2026.pdf" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(fixtures.restore).toHaveBeenCalledWith({ ids: [entry.id] }, expect.anything());

    fixtures.restoreConflict = true;
    lastRestoreCallbacks().onError(new Error("conflict"));
    expect(fixtures.toastError).toHaveBeenCalledWith(
      'Could not restore "Taxes 2026.pdf": a file already exists at that location.',
      expect.anything(),
    );
  });

  it("shows decrypted names in the grid too", async () => {
    window.localStorage.setItem("fdrive.view", JSON.stringify("grid"));
    const { account, info } = await encryptedTrash();
    vi.spyOn(apiClient, "encryptedFolder").mockResolvedValue({ folder: info });
    await keyStore.unlocked(account.identity);
    renderPage();
    expect(await screen.findByText("Taxes 2026.pdf")).toBeDefined();
    expect(screen.getByText("/Private/Receipts")).toBeDefined();
  });

  it("shows an encrypted item while this browser is locked, without asking for its folder", async () => {
    const { taxes } = await encryptedTrash();
    const lookup = vi.spyOn(apiClient, "encryptedFolder");
    renderPage();

    await waitFor(() => expect(keyStore.get().status).toBe("locked"));
    expect(screen.getByText("Encrypted item")).toBeDefined();
    expect(screen.getByText("/Private/…")).toBeDefined();
    expect(screen.getByRole("checkbox", { name: "Select Encrypted item" })).toBeDefined();
    expect(screen.getByText("report.txt")).toBeDefined();
    expect(screen.queryByText(taxes)).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("shows an encrypted item when its folder is gone or its marker does not open", async () => {
    const { account, info } = await encryptedTrash();
    const lookup = vi.spyOn(apiClient, "encryptedFolder").mockResolvedValue({ folder: null });
    await keyStore.unlocked(account.identity);
    const view = renderPage();
    await waitFor(() => expect(lookup).toHaveBeenCalled());
    expect(screen.getByText("Encrypted item")).toBeDefined();
    view.unmount();

    const stranger = await crypto.newKeyPair();
    const foreign = await crypto.createFolder(stranger.identity);
    lookup.mockResolvedValue({ folder: { ...info, marker: foreign.marker } });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderPage();
    await waitFor(() => expect(lookup).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Encrypted item")).toBeDefined();
  });
});
