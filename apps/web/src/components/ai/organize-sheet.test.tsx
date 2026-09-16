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
    list: vi.fn(),
  },
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({
  apiClient: mocks.client,
  snapshotTabApiClient: () => mocks.client,
  pinTabIdentity: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { success: mocks.success, error: mocks.error, info: mocks.info },
}));
vi.mock("@/components/files/destination-picker", () => ({
  DestinationPicker: (props: { open: boolean; onConfirm: (path: string) => void }) =>
    props.open ? (
      <button type="button" onClick={() => props.onConfirm("/Archive")}>
        Pick /Archive
      </button>
    ) : null,
}));

const { OrganizeSheet } = await import("./organize-sheet");
const { useOrganizeSessionStore } = await import("@/lib/ai/organize-session");
const { useOrganize } = await import("@/lib/ai/use-organize");

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
const others = [entry("/inbox/other.txt")];

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

/** The file browser's side of the sheet: opens it for a selection and shows the closed-sheet status. */
function Harness({ onMoved }: { onMoved?: () => void }) {
  const organize = useOrganize();
  return (
    <>
      <button type="button" onClick={() => organize.open(entries)}>
        Open selection
      </button>
      <button type="button" onClick={() => organize.open(others)}>
        Open others
      </button>
      <output data-testid="status">
        {organize.status === null ? "" : `${organize.status.state}:${organize.status.count}`}
      </output>
      <OrganizeSheet organize={organize} provider="anthropic" {...(onMoved ? { onMoved } : {})} />
    </>
  );
}

function renderSheet(props: { onMoved?: () => void } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <Harness {...props} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open selection" }));
  return { ...view, queryClient };
}

function sheet() {
  return screen.getByRole("dialog");
}

/** The sheet's own close control, as the X button or Escape would. */
function closeSheet() {
  fireEvent.click(within(sheet()).getAllByRole("button", { name: "Close" })[0] as HTMLElement);
}

function status() {
  return screen.getByTestId("status").textContent;
}

beforeEach(() => {
  for (const mock of Object.values(mocks.client)) mock.mockReset();
  mocks.success.mockReset();
  mocks.error.mockReset();
  mocks.info.mockReset();
  mocks.client.startOrganize.mockResolvedValue(run({}));
  useOrganizeSessionStore.getState().reset();
});
afterEach(cleanup);

async function reachReview() {
  mocks.client.organizeRun.mockResolvedValue(done);
  fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "  by type " } });
  fireEvent.click(screen.getByRole("button", { name: "Suggest moves" }));
  await screen.findByText("Receipts go to Finance and photos to Photos.");
}

it("lets the person keep file contents and other file names from the assistant", async () => {
  window.localStorage.removeItem("fdrive.organize.share");
  renderSheet();
  const trigger = screen.getByRole("combobox", { name: "Share with assistant" });
  const triggerText = () => trigger.querySelector('[data-slot="select-value"]')?.textContent;
  expect(triggerText()).toBe("File contents, names of other files");

  fireEvent.click(trigger);
  const contents = await screen.findByRole("option", { name: /File contents/ });
  expect(contents.getAttribute("aria-selected")).toBe("true");
  expect(
    screen.getByRole("option", { name: /Names of other files/ }).getAttribute("aria-selected"),
  ).toBe("true");
  fireEvent.keyDown(contents, { key: "Enter" });
  await waitFor(() => expect(triggerText()).toBe("Names of other files"));
  expect(window.localStorage.getItem("fdrive.organize.share")).toBe(
    JSON.stringify({ contents: false, otherFileNames: true }),
  );
  fireEvent.keyDown(contents, { key: "Escape" });
  mocks.client.organizeRun.mockResolvedValue(run({ activity: ["Looked through /"] }));
  fireEvent.click(screen.getByRole("button", { name: "Suggest moves" }));
  await waitFor(() =>
    expect(mocks.client.startOrganize).toHaveBeenCalledWith({
      paths: ["/inbox/receipt.pdf", "/inbox/beach.jpg", "/inbox/notes.txt"],
      share: { contents: false, otherFileNames: true },
    }),
  );
  window.localStorage.removeItem("fdrive.organize.share");
});

it("explains what is sent, then reviews suggestions grouped by destination", async () => {
  renderSheet();
  expect(screen.getByText("Organize 3 items")).toBeTruthy();
  expect(screen.getByText(/sent to\s+Claude \(Anthropic\)/)).toBeTruthy();

  await reachReview();
  expect(mocks.client.startOrganize).toHaveBeenCalledWith({
    paths: ["/inbox/receipt.pdf", "/inbox/beach.jpg", "/inbox/notes.txt"],
    instructions: "by type",
    share: { contents: true, otherFileNames: true },
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
  renderSheet({ onMoved });
  await reachReview();
  mocks.client.moveMany.mockResolvedValueOnce({
    results: [{ ok: true, path: "/inbox/receipt.pdf", target: "/Finance/Receipts/receipt.pdf" }],
  });

  fireEvent.click(screen.getByRole("button", { name: "Move 1 item" }));

  await waitFor(() => expect(useOrganizeSessionStore.getState().session).toBeNull());
  expect(status()).toBe("");
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
  renderSheet();
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
  expect(useOrganizeSessionStore.getState().session).not.toBeNull();
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

it("shows progress, stops from the button, and keeps the run when closed", async () => {
  mocks.client.organizeRun.mockResolvedValue(
    run({ activity: ["Looked through /", "Read 2 files"] }),
  );
  mocks.client.cancelOrganize.mockResolvedValue(run({ state: "cancelled" }));
  renderSheet();
  fireEvent.click(screen.getByRole("button", { name: "Suggest moves" }));
  expect(await screen.findByText("Read 2 files")).toBeTruthy();

  closeSheet();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(mocks.client.cancelOrganize).not.toHaveBeenCalled();
  expect(status()).toBe("running:3");

  fireEvent.click(screen.getByRole("button", { name: "Open selection" }));
  expect(await screen.findByText("Read 2 files")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(mocks.client.cancelOrganize).toHaveBeenCalledWith("run-1"));
  expect(await screen.findByText("Stopped. Nothing was moved.")).toBeTruthy();
  closeSheet();
  await waitFor(() => expect(useOrganizeSessionStore.getState().session).toBeNull());
});

it("offers a way back to suggestions that arrived while the sheet was closed", async () => {
  mocks.client.organizeRun.mockResolvedValue(run({ activity: ["Looked through /"] }));
  renderSheet();
  fireEvent.click(screen.getByRole("button", { name: "Suggest moves" }));
  expect(await screen.findByText("Looked through /")).toBeTruthy();
  closeSheet();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  mocks.client.organizeRun.mockResolvedValue(done);
  await waitFor(() => expect(status()).toBe("ready:3"));
  await waitFor(() => expect(mocks.info).toHaveBeenCalledTimes(1));
  const [message, options] = mocks.info.mock.calls[0] as [
    string,
    { action: { onClick: () => void } },
  ];
  expect(message).toBe("Suggestions ready");

  options.action.onClick();
  expect(await screen.findByText("Receipts go to Finance and photos to Photos.")).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "Move all into /Photos" }));
  expect(screen.getByRole("button", { name: "Move 2 items" })).toBeTruthy();

  // Closing a review already seen keeps the edits and does not nag.
  closeSheet();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(status()).toBe("ready:3");
  fireEvent.click(screen.getByRole("button", { name: "Open selection" }));
  expect(await screen.findByRole("button", { name: "Move 2 items" })).toBeTruthy();
  expect(mocks.info).toHaveBeenCalledTimes(1);
});

it("stops a run when another selection replaces it, even one still starting", async () => {
  const started = Promise.withResolvers<OrganizeRun>();
  mocks.client.startOrganize.mockReturnValueOnce(started.promise);
  mocks.client.cancelOrganize.mockResolvedValue(run({ state: "cancelled" }));
  renderSheet();
  fireEvent.click(screen.getByRole("button", { name: "Suggest moves" }));
  await waitFor(() => expect(mocks.client.startOrganize).toHaveBeenCalled());
  closeSheet();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(status()).toBe("running:3");

  fireEvent.click(screen.getByRole("button", { name: "Open others" }));
  expect(await screen.findByText("Organize 1 item")).toBeTruthy();
  started.resolve(run({}));
  await waitFor(() => expect(mocks.client.cancelOrganize).toHaveBeenCalledWith("run-1"));
  expect(mocks.client.organizeRun).not.toHaveBeenCalled();

  mocks.client.cancelOrganize.mockClear();
  mocks.client.startOrganize.mockResolvedValue(run({ id: "run-2" }));
  mocks.client.organizeRun.mockResolvedValue(run({ id: "run-2", activity: ["Looked through /"] }));
  fireEvent.click(screen.getByRole("button", { name: "Suggest moves" }));
  expect(await screen.findByText("Looked through /")).toBeTruthy();
  closeSheet();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Open selection" }));
  await waitFor(() => expect(mocks.client.cancelOrganize).toHaveBeenCalledWith("run-2"));
  expect(screen.getByText("Organize 3 items")).toBeTruthy();
});

it("keeps both by moving under a numbered name", async () => {
  renderSheet();
  await reachReview();
  mocks.client.list.mockResolvedValueOnce({
    path: "/Photos",
    entries: [entry("/Photos/beach.jpg"), entry("/Photos/beach (2).jpg")],
  });

  fireEvent.click(screen.getByRole("button", { name: "Keep both" }));

  expect(await screen.findByText("beach (3).jpg")).toBeTruthy();
  expect(mocks.client.list).toHaveBeenCalledWith("/Photos");
  const photos = screen.getByRole("region", { name: "/Photos" });
  expect(within(photos).queryByText("Something with this name is already there.")).toBeNull();
  expect(screen.queryByRole("button", { name: "Keep both" })).toBeNull();
  mocks.client.moveMany.mockResolvedValueOnce({ results: [] });
  fireEvent.click(screen.getByRole("button", { name: "Move 2 items" }));
  await waitFor(() =>
    expect(mocks.client.moveMany).toHaveBeenCalledWith({
      items: [
        { path: "/inbox/receipt.pdf", target: "/Finance/Receipts/receipt.pdf" },
        { path: "/inbox/beach.jpg", target: "/Photos/beach (3).jpg" },
      ],
      createParents: true,
    }),
  );
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
