// @vitest-environment jsdom
import type { Chat } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// The sticky conversation scroller measures itself; jsdom has no ResizeObserver.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;
// Base UI's scroll area asks the viewport for its animations; jsdom has none.
(Element.prototype as { getAnimations?: () => Animation[] }).getAnimations ??= () => [];

const mocks = vi.hoisted(() => ({
  client: {
    aiStatus: vi.fn(),
    chats: vi.fn(),
    createChat: vi.fn(),
    chat: vi.fn(),
    renameChat: vi.fn(),
    deleteChat: vi.fn(),
    sendChatMessage: vi.fn(),
    cancelChat: vi.fn(),
    actOnChat: vi.fn(),
    moveMany: vi.fn(),
  },
  push: vi.fn(),
  pathname: "/files/Inbox",
  mobile: false,
  error: vi.fn(),
  success: vi.fn(),
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: mocks.client,
  snapshotTabApiClient: () => mocks.client,
  pinTabIdentity: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => mocks.mobile }));
vi.mock("sonner", () => ({ toast: { error: mocks.error, success: mocks.success } }));
vi.mock("@/components/files/destination-picker", () => ({ DestinationPicker: () => null }));

const { ChatPanel } = await import("./chat-panel");
const { LiveActivityDock } = await import("@/components/activity/live-activity-dock");
const { addToChat, setChatPanelOpen, setCurrentChatId, useChatPanelStore } = await import(
  "@/lib/ai/chat-panel"
);
const { startDragSession, endDragSession, INTERNAL_DND_TYPE } = await import("@/lib/dnd");

function chat(patch: Partial<Chat> = {}): Chat {
  return {
    id: "c1",
    title: "What are these?",
    createdAt: "2026-09-18T10:00:00.000Z",
    updatedAt: "2026-09-18T10:00:00.000Z",
    lastMessageAt: "2026-09-18T10:00:00.000Z",
    state: "idle",
    share: { contents: true, otherFileNames: true },
    references: [{ path: "/Inbox/a.txt", missing: false }],
    messages: [
      {
        id: "m1",
        role: "user",
        parts: [{ kind: "text", text: "What are these?" }],
        references: ["/Inbox/a.txt"],
        location: "/Inbox",
        createdAt: "2026-09-18T10:00:00.000Z",
      },
      {
        id: "m2",
        role: "assistant",
        parts: [
          {
            kind: "tool",
            id: "t1",
            name: "read_file",
            activity: "Read a.txt",
            input: '{"path":"/Inbox/a.txt"}',
            output: "hello",
            state: "done",
          },
          { kind: "text", text: "A note saying hello: /Inbox/a.txt" },
        ],
        references: [],
        location: null,
        createdAt: "2026-09-18T10:00:01.000Z",
      },
    ],
    ...patch,
  };
}

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <LiveActivityDock>
        <ChatPanel />
      </LiveActivityDock>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.client.aiStatus.mockResolvedValue({ provider: "anthropic", organize: true, chat: true });
  mocks.client.chats.mockResolvedValue({
    chats: [
      {
        id: "c1",
        title: "What are these?",
        createdAt: "2026-09-18T10:00:00.000Z",
        updatedAt: "2026-09-18T10:00:00.000Z",
        lastMessageAt: "2026-09-18T10:00:00.000Z",
      },
    ],
  });
  mocks.client.chat.mockResolvedValue(chat());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  useChatPanelStore.getState().clearChips();
  mocks.mobile = false;
});

it("stays hidden until AI is set up, and closed shows only a pill while something is happening", async () => {
  mocks.client.aiStatus.mockResolvedValue({ provider: null, organize: false, chat: false });
  const { container } = renderPanel();
  await waitFor(() => expect(mocks.client.aiStatus).toHaveBeenCalled());
  expect(container.querySelector('[data-slot="chat-panel"]')).toBeNull();

  cleanup();
  mocks.client.aiStatus.mockResolvedValue({ provider: "anthropic", organize: true, chat: true });
  mocks.client.chat.mockResolvedValue(chat({ state: "awaiting_approval" }));
  setCurrentChatId("c1");
  renderPanel();
  const pill = await screen.findByRole("button", { name: "Waiting for you" });
  fireEvent.click(pill);
  expect(await screen.findByRole("complementary", { name: "Chat" })).toBeTruthy();
});

it("starts a chat from a suggestion with the attached chips and the current folder", async () => {
  mocks.client.createChat.mockResolvedValue(
    chat({ id: "c9", title: "New chat", references: [], messages: [] }),
  );
  mocks.client.sendChatMessage.mockResolvedValue(
    chat({ id: "c9", state: "running", messages: [] }),
  );
  setChatPanelOpen(true);
  addToChat(["/Inbox/a.txt"]);
  renderPanel();

  expect(await screen.findByText("Ask about your files")).toBeTruthy();
  expect(screen.getByText("a.txt")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "What are these files about?" }));

  await waitFor(() =>
    expect(mocks.client.sendChatMessage).toHaveBeenCalledWith("c9", {
      text: "What are these files about?",
      references: ["/Inbox/a.txt"],
      location: "/Inbox",
    }),
  );
  expect(localStorage.getItem("fdrive.chat.current")).toBe('"c9"');
  await waitFor(() => expect(useChatPanelStore.getState().chips).toEqual([]));
});

it("shows the transcript with tool rows and links, sends typed messages, and can stop a reply", async () => {
  setChatPanelOpen(true);
  setCurrentChatId("c1");
  mocks.client.sendChatMessage.mockResolvedValue(
    chat({
      state: "running",
      messages: [
        ...chat().messages,
        {
          id: "m3",
          role: "user",
          parts: [{ kind: "text", text: "More?" }],
          references: [],
          location: "/Inbox",
          createdAt: "2026-09-18T10:00:02.000Z",
        },
        {
          id: "m4",
          role: "assistant",
          parts: [],
          references: [],
          location: null,
          createdAt: "2026-09-18T10:00:02.000Z",
        },
      ],
    }),
  );
  mocks.client.cancelChat.mockResolvedValue(chat());
  renderPanel();

  expect(await screen.findByText("Read a.txt")).toBeTruthy();
  const link = await screen.findByRole("link", { name: "/Inbox/a.txt" });
  expect(link.getAttribute("href")).toBe("/files/Inbox?select=a.txt");
  fireEvent.click(link);
  expect(mocks.push).toHaveBeenCalledWith("/files/Inbox?select=a.txt");

  const textarea = screen.getByRole("textbox", { name: "Message" });
  fireEvent.change(textarea, { target: { value: "More?" } });
  fireEvent.keyDown(textarea, { key: "Enter" });
  await waitFor(() =>
    expect(mocks.client.sendChatMessage).toHaveBeenCalledWith("c1", {
      text: "More?",
      references: [],
      location: "/Inbox",
    }),
  );
  expect(await screen.findByText("Thinking…")).toBeTruthy();
  expect(screen.getByText("Answering…")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(mocks.client.cancelChat).toHaveBeenCalledWith("c1"));
});

it("takes files dropped from a listing as chips and lets them be removed", async () => {
  setChatPanelOpen(true);
  renderPanel();
  const panel = await screen.findByRole("complementary", { name: "Chat" });
  const zone = panel.querySelector("[data-dropping], .relative.flex.min-h-0") as HTMLElement;
  const dataTransfer = {
    types: [INTERNAL_DND_TYPE],
    getData: () => JSON.stringify(["/Inbox/b.txt", "/Docs"]),
    setData: () => {},
    dropEffect: "none",
  };
  act(() => startDragSession(["/Inbox/b.txt", "/Docs"]));
  fireEvent.dragOver(zone, { dataTransfer });
  expect(screen.getByText("Drop to add to chat")).toBeTruthy();
  fireEvent.drop(zone, { dataTransfer });
  act(() => endDragSession());
  expect(useChatPanelStore.getState().chips).toEqual(["/Inbox/b.txt", "/Docs"]);
  expect(screen.getByText("b.txt")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove b.txt" }));
  expect(useChatPanelStore.getState().chips).toEqual(["/Docs"]);
});

it("folds more than ten chips into one badge that lists, trims and clears them", async () => {
  const paths = Array.from({ length: 12 }, (_, i) => `/Inbox/f${i}.pdf`);
  act(() => addToChat(paths));
  renderPanel();
  const attached = await screen.findByRole("group", { name: "Attached to the next message" });
  expect(attached.textContent).toContain("12 items");
  expect(screen.queryByText("f0.pdf")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "12 items" }));
  const list = await screen.findByRole("list", { name: "Attached items" });
  expect(list.querySelectorAll("li")).toHaveLength(12);
  fireEvent.click(screen.getByRole("button", { name: "Remove f0.pdf" }));
  expect(useChatPanelStore.getState().chips).toEqual(paths.slice(1));
  expect(await screen.findByRole("button", { name: "11 items" })).toBeTruthy();

  // Back at ten, every chip shows on its own again.
  fireEvent.click(screen.getByRole("button", { name: "Remove f1.pdf" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: /items$/ })).toBeNull());
  expect(attached.querySelectorAll('[data-slot="badge"]')).toHaveLength(10);

  act(() => addToChat(["/Inbox/extra.pdf"]));
  fireEvent.click(screen.getByRole("button", { name: "Remove all" }));
  expect(useChatPanelStore.getState().chips).toEqual([]);
});

it("applies a card, switches chats from the menu, and closes", async () => {
  setChatPanelOpen(true);
  setCurrentChatId("c1");
  const pending = chat({
    state: "awaiting_approval",
    messages: [
      ...chat().messages,
      {
        id: "m5",
        role: "assistant",
        parts: [
          {
            kind: "action",
            id: "a1",
            state: "pending",
            proposal: {
              kind: "trash",
              summary: "Remove it.",
              items: [{ path: "/Inbox/a.txt", kind: "file", reason: "Old." }],
            },
          },
        ],
        references: [],
        location: null,
        createdAt: "2026-09-18T10:00:03.000Z",
      },
    ],
  });
  mocks.client.chat.mockResolvedValue(pending);
  mocks.client.actOnChat.mockResolvedValue({ ...pending, state: "running" });
  mocks.client.deleteChat.mockResolvedValue(undefined);
  renderPanel();

  expect(await screen.findByText("Apply or decline the card above to continue.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Trash 1 item" }));
  await waitFor(() =>
    expect(mocks.client.actOnChat).toHaveBeenCalledWith("c1", "a1", {
      decision: "apply",
      edits: {},
    }),
  );

  fireEvent.click(screen.getByRole("button", { name: "Chats" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "New chat" }));
  expect(localStorage.getItem("fdrive.chat.current")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Close chat" }));
  await waitFor(() => expect(screen.queryByRole("complementary", { name: "Chat" })).toBeNull());
  expect(localStorage.getItem("fdrive.chat.open")).toBe("false");
});

it("opens as a sheet on narrow screens and toggles with the keyboard shortcut", async () => {
  mocks.mobile = true;
  setChatPanelOpen(true);
  renderPanel();
  expect(await screen.findByRole("dialog")).toBeTruthy();
  fireEvent.keyDown(window, { key: "k", shiftKey: true, metaKey: true });
  await waitFor(() => expect(localStorage.getItem("fdrive.chat.open")).toBe("false"));
});
