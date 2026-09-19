// @vitest-environment jsdom
import type { ChatActionRequest, ChatPart } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  client: { moveMany: vi.fn() },
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

const { ChatActionCard } = await import("./chat-action-card");

type ActionPart = ChatPart & { kind: "action" };

const MOVE: ActionPart = {
  kind: "action",
  id: "a1",
  state: "pending",
  proposal: {
    kind: "move",
    summary: "File these away.",
    suggestions: [
      {
        path: "/Inbox/a.txt",
        kind: "file",
        destination: "/Docs",
        target: "/Docs/a.txt",
        reason: "Notes.",
        newFolder: false,
        conflict: false,
      },
      {
        path: "/Inbox/b.txt",
        kind: "file",
        destination: "/Docs",
        target: "/Docs/b.txt",
        reason: "Taken.",
        newFolder: false,
        conflict: true,
      },
    ],
    unchanged: [{ path: "/Inbox/c.txt", reason: "Already there." }],
  },
};

function renderCard(part: ActionPart, onAct = vi.fn(async () => {})) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ChatActionCard
        chat={{ id: "c1", state: "awaiting_approval" }}
        part={part}
        busy={false}
        onAct={onAct}
      />
    </QueryClientProvider>,
  );
  return { ...view, onAct };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("applies a move card with the kept items and chosen folders", async () => {
  const { onAct } = renderCard(MOVE);
  const card = screen.getByRole("region", { name: "File these away." });
  expect(within(card).getByText("Something with this name is already there.")).toBeTruthy();
  expect(within(card).getByText(/Already there\./)).toBeTruthy();
  const apply = within(card).getByRole("button", { name: "Move 1 item" });

  fireEvent.click(within(card).getByRole("button", { name: "Choose another folder for b.txt" }));
  fireEvent.click(screen.getByRole("button", { name: "Pick /Archive" }));
  expect(within(card).getByRole("button", { name: "Move 2 items" })).toBeTruthy();
  fireEvent.click(within(card).getByRole("checkbox", { name: "Move a.txt" }));
  fireEvent.click(within(card).getByRole("button", { name: "Move 1 item" }));

  await waitFor(() => expect(onAct).toHaveBeenCalledTimes(1));
  expect(onAct).toHaveBeenCalledWith("a1", {
    decision: "apply",
    edits: { moves: [{ path: "/Inbox/b.txt", target: "/Archive/b.txt" }] },
  } satisfies ChatActionRequest);
  void apply;
});

it("declines a card and shows outcomes with undo for applied moves", async () => {
  const { onAct } = renderCard(MOVE);
  fireEvent.click(screen.getByRole("button", { name: "Decline" }));
  await waitFor(() => expect(onAct).toHaveBeenCalledWith("a1", { decision: "decline" }));

  cleanup();
  mocks.client.moveMany.mockResolvedValue({
    results: [{ ok: true, path: "/Docs/a.txt", target: "/Inbox/a.txt" }],
  });
  renderCard({
    ...MOVE,
    state: "applied",
    outcome: "Moved 1 of 2 items.",
    results: [
      { path: "/Inbox/a.txt", ok: true, target: "/Docs/a.txt" },
      { path: "/Inbox/b.txt", ok: false, target: "/Docs/b.txt", message: "taken" },
    ],
  });
  expect(screen.getByText("Applied")).toBeTruthy();
  expect(screen.getByText("Moved 1 of 2 items.")).toBeTruthy();
  expect(screen.getByText("taken", { exact: false })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(mocks.client.moveMany).toHaveBeenCalled());
  expect(mocks.client.moveMany.mock.calls[0]?.[0]).toMatchObject({
    items: [{ path: "/Docs/a.txt", target: "/Inbox/a.txt" }],
  });
  await waitFor(() => expect(mocks.success).toHaveBeenCalledWith("Moved back."));
});

it("lets the person keep some items out of a trash card", async () => {
  const { onAct } = renderCard({
    kind: "action",
    id: "t1",
    state: "pending",
    proposal: {
      kind: "trash",
      summary: "Old drafts.",
      items: [
        { path: "/Inbox/a.txt", kind: "file", reason: "Empty." },
        { path: "/Inbox/b.txt", kind: "file", reason: "Empty." },
      ],
    },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Trash b.txt" }));
  fireEvent.click(screen.getByRole("button", { name: "Trash 1 item" }));
  await waitFor(() =>
    expect(onAct).toHaveBeenCalledWith("t1", {
      decision: "apply",
      edits: { paths: ["/Inbox/a.txt"] },
    }),
  );
});

it("shows a draft, lets the name change for a new file, and explains a replace", async () => {
  const { onAct } = renderCard({
    kind: "action",
    id: "w1",
    state: "pending",
    proposal: {
      kind: "write",
      summary: "A tidier version.",
      path: "/Inbox/notes.md",
      mode: "create",
      text: "# Notes\n\nHello.",
      expectedSha256: null,
    },
  });
  expect(screen.getByText("New file")).toBeTruthy();
  expect(screen.getByText(/# Notes/)).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: "File name" }), {
    target: { value: "tidy.md" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create file" }));
  await waitFor(() =>
    expect(onAct).toHaveBeenCalledWith("w1", {
      decision: "apply",
      edits: { path: "/Inbox/tidy.md" },
    }),
  );

  cleanup();
  renderCard({
    kind: "action",
    id: "w2",
    state: "pending",
    proposal: {
      kind: "write",
      summary: "Rewrite.",
      path: "/Inbox/notes.md",
      mode: "replace",
      text: "x",
      expectedSha256: "abc",
    },
  });
  expect(screen.getByText("Replaces")).toBeTruthy();
  expect(screen.getByText(/unchanged since it was read/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Replace file" })).toBeTruthy();
});
