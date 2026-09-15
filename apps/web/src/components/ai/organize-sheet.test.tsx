// @vitest-environment jsdom
import type { FsEntry, OrganizeRun } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  client: {
    startOrganize: vi.fn(),
    organizeRun: vi.fn(),
    cancelOrganize: vi.fn(),
    moveMany: vi.fn(),
  },
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({
  apiClient: mocks.client,
  snapshotTabApiClient: () => mocks.client,
  pinTabIdentity: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock("@/components/files/destination-picker", () => ({
  DestinationPicker: (props: { open: boolean; onConfirm: (path: string) => void }) =>
    props.open ? (
      <button type="button" onClick={() => props.onConfirm("/Archive")}>
        Pick /Archive
      </button>
    ) : null,
}));

const { OrganizeSheet } = await import("./organize-sheet");

function entry(path: string): FsEntry {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return {
    name,
    path,
    kind: "file",
    size: 1,
    ext: name.slice(name.lastIndexOf(".")),
    mime: null,
    modifiedAt: "2026-01-01T00:00:00.000Z",
  };
}

const entries = [entry("/inbox/receipt.pdf"), entry("/inbox/beach.jpg"), entry("/inbox/notes.txt")];

function run(patch: Partial<OrganizeRun>): OrganizeRun {
  return {
    id: "run-1",
    state: "running",
    createdAt: "2026-09-15T10:00:00.000Z",
    updatedAt: "2026-09-15T10:00:00.000Z",
    itemCount: 3,
    activity: [],
    ...patch,
  };
}

const done = run({
  state: "done",
  proposal: {
    summary: "Receipts go to Finance and photos to Photos.",
    suggestions: [
      {
        path: "/inbox/receipt.pdf",
        kind: "file",
        destination: "/Finance/Receipts",
        target: "/Finance/Receipts/receipt.pdf",
        reason: "A grocery receipt.",
        newFolder: true,
        conflict: false,
      },
      {
        path: "/inbox/beach.jpg",
        kind: "file",
        destination: "/Photos",
        target: "/Photos/beach.jpg",
        reason: "A holiday photo.",
        newFolder: false,
        conflict: true,
      },
    ],
    unchanged: [{ path: "/inbox/notes.txt", reason: "Unclear what it is about." }],
  },
});

function renderSheet(props: { onClose?: () => void; onMoved?: () => void } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onClose = props.onClose ?? vi.fn();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <OrganizeSheet
        entries={entries}
        provider="anthropic"
        onClose={onClose}
        {...(props.onMoved ? { onMoved: props.onMoved } : {})}
      />
    </QueryClientProvider>,
  );
  return { ...view, onClose, queryClient };
}

beforeEach(() => {
  for (const mock of Object.values(mocks.client)) mock.mockReset();
  mocks.success.mockReset();
  mocks.error.mockReset();
  mocks.client.startOrganize.mockResolvedValue(run({}));
});
afterEach(cleanup);

async function reachReview() {
  mocks.client.organizeRun.mockResolvedValue(done);
  fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "  by type " } });
  fireEvent.click(screen.getByRole("button", { name: "Suggest moves" }));
  await screen.findByText("Receipts go to Finance and photos to Photos.");
}

it("explains what is sent, then reviews suggestions grouped by destination", async () => {
  renderSheet();
  expect(screen.getByText("Organize 3 items")).toBeTruthy();
  expect(screen.getByText(/sent to\s+Claude \(Anthropic\)/)).toBeTruthy();

  await reachReview();
  expect(mocks.client.startOrganize).toHaveBeenCalledWith({
    paths: ["/inbox/receipt.pdf", "/inbox/beach.jpg", "/inbox/notes.txt"],
    instructions: "by type",
  });
  const finance = screen.getByRole("region", { name: "/Finance/Receipts" });
  expect(within(finance).getByText("New folder")).toBeTruthy();
  expect(within(finance).getByText("A grocery receipt.")).toBeTruthy();
  const photos = screen.getByRole("region", { name: "/Photos" });
  expect(within(photos).getByText("Something with this name is already there.")).toBeTruthy();
  // Conflicts start unchecked, so only the receipt would move.
  expect(screen.getByRole("button", { name: "Move 1 item" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "1 item stay where they are" }));
  expect(await screen.findByText(/Unclear what it is about/)).toBeTruthy();
});

it("moves the checked items, offers undo, and closes when everything moved", async () => {
  const onMoved = vi.fn();
  const { onClose } = renderSheet({ onMoved });
  await reachReview();
  mocks.client.moveMany.mockResolvedValueOnce({
    results: [{ ok: true, path: "/inbox/receipt.pdf", target: "/Finance/Receipts/receipt.pdf" }],
  });

  fireEvent.click(screen.getByRole("button", { name: "Move 1 item" }));

  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(mocks.client.moveMany).toHaveBeenCalledWith({
    items: [{ path: "/inbox/receipt.pdf", target: "/Finance/Receipts/receipt.pdf" }],
    createParents: true,
  });
  expect(onMoved).toHaveBeenCalledWith(["/Finance/Receipts/receipt.pdf"]);
  const [message, options] = mocks.success.mock.calls[0] as [
    string,
    { action: { onClick: () => void } },
  ];
  expect(message).toBe("Moved 1 item");

  mocks.client.moveMany.mockResolvedValueOnce({
    results: [{ ok: true, path: "/Finance/Receipts/receipt.pdf", target: "/inbox/receipt.pdf" }],
  });
  options.action.onClick();
  await waitFor(() => expect(mocks.success).toHaveBeenCalledWith("Moved 1 item back"));
  expect(mocks.client.moveMany).toHaveBeenLastCalledWith({
    items: [{ path: "/Finance/Receipts/receipt.pdf", target: "/inbox/receipt.pdf" }],
  });
});

it("keeps failed items on screen with their reason", async () => {
  const { onClose } = renderSheet();
  await reachReview();
  fireEvent.click(screen.getByRole("checkbox", { name: "Move all into /Photos" }));
  mocks.client.moveMany.mockResolvedValueOnce({
    results: [
      {
        ok: true,
        path: "/inbox/receipt.pdf",
        target: "/Finance/Receipts/receipt.pdf",
        warning: "tags",
      },
      {
        ok: false,
        path: "/inbox/beach.jpg",
        target: "/Photos/beach.jpg",
        error: { kind: "conflict", message: "something already exists at /Photos/beach.jpg" },
      },
    ],
  });

  fireEvent.click(screen.getByRole("button", { name: "Move 2 items" }));

  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "something already exists at /Photos/beach.jpg",
  );
  expect(screen.queryByRole("region", { name: "/Finance/Receipts" })).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  expect(mocks.success.mock.calls[0]?.[1]).toMatchObject({
    description: "Tags or favorites of 1 item could not follow.",
  });
});

it("lets the person choose another folder for one suggestion", async () => {
  renderSheet();
  await reachReview();
  fireEvent.click(screen.getByRole("button", { name: "Choose another folder for beach.jpg" }));
  fireEvent.click(screen.getByRole("button", { name: "Pick /Archive" }));

  const archive = await screen.findByRole("region", { name: "/Archive" });
  expect(within(archive).queryByText("Something with this name is already there.")).toBeNull();
  expect(screen.getByRole("button", { name: "Move 2 items" })).toBeTruthy();
});

it("shows progress, and stops the assistant from the button or by closing", async () => {
  mocks.client.organizeRun.mockResolvedValue(
    run({ activity: ["Looked through /", "Read 2 files"] }),
  );
  mocks.client.cancelOrganize.mockResolvedValue(run({ state: "cancelled" }));
  renderSheet();
  fireEvent.click(screen.getByRole("button", { name: "Suggest moves" }));

  expect(await screen.findByText("Read 2 files")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(mocks.client.cancelOrganize).toHaveBeenCalledWith("run-1"));
  expect(await screen.findByText("Stopped. Nothing was moved.")).toBeTruthy();

  cleanup();
  mocks.client.cancelOrganize.mockClear();
  const { unmount } = renderSheet();
  fireEvent.click(screen.getByRole("button", { name: "Suggest moves" }));
  await screen.findByText("Read 2 files");
  expect(mocks.client.cancelOrganize).not.toHaveBeenCalled();
  unmount();
  await waitFor(() => expect(mocks.client.cancelOrganize).toHaveBeenCalledWith("run-1"));
});

it("stops a run whose start only returns after the sheet closed", async () => {
  const started = Promise.withResolvers<OrganizeRun>();
  mocks.client.startOrganize.mockReturnValueOnce(started.promise);
  mocks.client.cancelOrganize.mockResolvedValue(run({ state: "cancelled" }));
  const { unmount } = renderSheet();
  fireEvent.click(screen.getByRole("button", { name: "Suggest moves" }));
  await waitFor(() => expect(mocks.client.startOrganize).toHaveBeenCalled());

  unmount();
  started.resolve(run({}));

  await waitFor(() => expect(mocks.client.cancelOrganize).toHaveBeenCalledWith("run-1"));
  expect(mocks.client.organizeRun).not.toHaveBeenCalled();
});

it("reports failures and starts over", async () => {
  mocks.client.organizeRun.mockResolvedValue(
    run({ state: "failed", error: "Anthropic rejected the API key." }),
  );
  renderSheet();
  fireEvent.click(screen.getByRole("button", { name: "Suggest moves" }));
  expect(await screen.findByText("Anthropic rejected the API key.")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(screen.getByRole("button", { name: "Suggest moves" })).toBeTruthy();

  mocks.client.startOrganize.mockRejectedValueOnce(new Error("offline"));
  fireEvent.click(screen.getByRole("button", { name: "Suggest moves" }));
  await waitFor(() => expect(mocks.error).toHaveBeenCalledWith("Could not start organizing."));
});
