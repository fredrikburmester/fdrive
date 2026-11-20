// @vitest-environment jsdom
import { ApiClientError, type Chat } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// jsdom has no ResizeObserver. The sticky conversation scroller measures itself with one and
// the panel watches the live activity dock with another; `resize` plays a size change for the
// observers of one element.
const resizeListeners = new Map<Element, Set<() => void>>();
class ResizeObserverStub {
  readonly #notify: () => void;
  readonly #targets = new Set<Element>();
  constructor(callback: ResizeObserverCallback) {
    this.#notify = () => callback([], this as unknown as ResizeObserver);
  }
  observe(target: Element) {
    this.#targets.add(target);
    const listeners = resizeListeners.get(target) ?? new Set();
    listeners.add(this.#notify);
    resizeListeners.set(target, listeners);
  }
  unobserve(target: Element) {
    this.#targets.delete(target);
    resizeListeners.get(target)?.delete(this.#notify);
  }
  disconnect() {
    for (const target of [...this.#targets]) this.unobserve(target);
  }
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
function resize(target: Element, height: number) {
  Object.defineProperty(target, "offsetHeight", { configurable: true, value: height });
  act(() => {
    for (const notify of resizeListeners.get(target) ?? []) notify();
  });
}
// Base UI's scroll area asks the viewport for its animations; jsdom has none.
(Element.prototype as { getAnimations?: () => Animation[] }).getAnimations ??= () => [];

const mocks = vi.hoisted(() => ({
  client: {
    aiStatus: vi.fn(),
    encryptedFolder: vi.fn(async () => ({ folder: null })),
    chats: vi.fn(),
    createChat: vi.fn(),
    chat: vi.fn(),
    renameChat: vi.fn(),
    deleteChat: vi.fn(),
    sendChatMessage: vi.fn(),
    cancelChat: vi.fn(),
    actOnChat: vi.fn(),
    moveMany: vi.fn(),
    stat: vi.fn(),
    list: vi.fn(),
  },
  push: vi.fn(),
  pathname: "/files/Inbox",
  mobile: false,
  error: vi.fn(),
  success: vi.fn(),
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: mocks.client,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => mocks.mobile }));
vi.mock("sonner", () => ({ toast: { error: mocks.error, success: mocks.success } }));
vi.mock("@/components/files/destination-picker", () => ({ DestinationPicker: () => null }));

const { ChatPanel } = await import("./chat-panel");
const { ChatToggle } = await import("./chat-toggle");
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

function entry(path: string, kind: "file" | "dir") {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return { name, path, kind, size: 0, modifiedAt: "2026-09-18T10:00:00.000Z", ext: "", mime: null };
}

function notFound() {
  return new ApiClientError("not_found", "That item could not be found.", 404);
}

/** The panel as the shell mounts it, with the toolbar button the file browser renders. */
function view(queryClient: QueryClient) {
  return (
    <QueryClientProvider client={queryClient}>
      <LiveActivityDock>
        <header>
          <ChatToggle />
        </header>
        <ChatPanel />
      </LiveActivityDock>
    </QueryClientProvider>
  );
}

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(view(queryClient));
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
  useChatPanelStore.setState({ focusPending: false });
  resizeListeners.clear();
  mocks.mobile = false;
  mocks.pathname = "/files/Inbox";
});

it("stays hidden until AI is set up, then opens and closes from the toolbar button, which says when something waits", async () => {
  mocks.client.aiStatus.mockResolvedValue({ provider: null, organize: false, chat: false });
  setChatPanelOpen(true);
  const { container } = renderPanel();
  await waitFor(() => expect(mocks.client.aiStatus).toHaveBeenCalled());
  expect(container.querySelector('[data-slot="chat-panel"]')).toBeNull();
  expect(screen.queryByRole("button", { name: "Chat" })).toBeNull();

  cleanup();
  localStorage.clear();
  mocks.client.aiStatus.mockResolvedValue({ provider: "anthropic", organize: true, chat: true });
  renderPanel();
  const toggle = await screen.findByRole("button", { name: "Chat" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("complementary", { name: "Chat" })).toBeNull();
  fireEvent.click(toggle);
  expect(await screen.findByRole("complementary", { name: "Chat" })).toBeTruthy();
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(toggle);
  await waitFor(() => expect(screen.queryByRole("complementary", { name: "Chat" })).toBeNull());
  expect(toggle.getAttribute("aria-expanded")).toBe("false");

  cleanup();
  mocks.client.chat.mockResolvedValue(chat({ state: "awaiting_approval" }));
  setCurrentChatId("c1");
  renderPanel();
  fireEvent.click(
    await screen.findByRole("button", { name: "Chat", description: "Waiting for you" }),
  );
  expect(await screen.findByRole("complementary", { name: "Chat" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Chat" }).getAttribute("aria-expanded")).toBe("true");
});

it("attaches items dropped on the toolbar button and opens the panel with them", async () => {
  renderPanel();
  const toggle = await screen.findByRole("button", { name: "Chat" });
  const dataTransfer = {
    types: [INTERNAL_DND_TYPE],
    getData: () => JSON.stringify(["/Inbox/b.txt"]),
    setData: () => {},
    dropEffect: "none",
  };
  act(() => startDragSession(["/Inbox/b.txt"]));
  fireEvent.dragOver(toggle, { dataTransfer });
  expect(toggle.getAttribute("data-dropping")).toBe("true");
  fireEvent.drop(toggle, { dataTransfer });
  act(() => endDragSession());
  expect(useChatPanelStore.getState().chips).toEqual(["/Inbox/b.txt"]);
  const panel = await screen.findByRole("complementary", { name: "Chat" });
  expect(panel.textContent).toContain("b.txt");
});

it("is only the header and the message box before the first message, and starts a chat with the attached chips and the open folder", async () => {
  mocks.client.createChat.mockResolvedValue(
    chat({ id: "c9", title: "New chat", references: [], messages: [] }),
  );
  mocks.client.sendChatMessage.mockResolvedValue(
    chat({ id: "c9", state: "running", messages: [] }),
  );
  addToChat(["/Inbox/a.txt"]);
  renderPanel();

  const panel = await screen.findByRole("complementary", { name: "Chat" });
  const chats = within(panel).getByRole("button", { name: "Chats" });
  expect(chats.textContent).toBe("New chat");
  expect(within(panel).getByText("a.txt")).toBeTruthy();
  // No transcript, no empty state and no suggestions: the message box follows the header.
  const textarea = within(panel).getByRole("textbox", { name: "Message" });
  expect(chats.parentElement?.nextElementSibling?.contains(textarea)).toBe(true);
  expect(screen.queryByRole("log")).toBeNull();
  expect(screen.queryByText("Ask about your files")).toBeNull();
  expect(screen.queryByRole("button", { name: "What are these files about?" })).toBeNull();
  expect(textarea.getAttribute("placeholder")).toBe("Ask about the attached items…");

  fireEvent.change(textarea, { target: { value: "What are these files about?" } });
  fireEvent.keyDown(textarea, { key: "Enter" });
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

it("hangs under the page header, stays open when the person clicks elsewhere, and ends above the live activity dock", async () => {
  setChatPanelOpen(true);
  renderPanel();
  const panel = await screen.findByRole("complementary", { name: "Chat" });
  expect(panel.className).toContain("fixed");
  expect(panel.className).toContain("top-14");
  expect(panel.className).toContain("right-3");
  // Under dialogs, sheets and the dock, which sit at z-50.
  expect(panel.className).toContain("z-40");
  expect(screen.queryByRole("dialog")).toBeNull();

  fireEvent.pointerDown(document.body);
  fireEvent.mouseDown(document.body);
  fireEvent.click(document.body);
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(screen.getByRole("complementary", { name: "Chat" })).toBeTruthy();

  // An empty dock leaves only a margin; one showing something is kept clear, gap included.
  const dock = document.querySelector('[data-slot="live-activity-dock"]') as HTMLElement;
  expect(dock.contains(panel)).toBe(false);
  expect(panel.style.getPropertyValue("--chat-dock-reserve")).toBe("16px");
  resize(dock, 200);
  expect(panel.style.getPropertyValue("--chat-dock-reserve")).toBe("224px");
  resize(dock, 0);
  expect(panel.style.getPropertyValue("--chat-dock-reserve")).toBe("16px");
});

it("puts the cursor in the message box when the person opens the panel, not when it was open already", async () => {
  // Restored from the browser's preference on page load: nobody asked for focus.
  localStorage.setItem("fdrive.chat.open", "true");
  renderPanel();
  await screen.findByRole("complementary", { name: "Chat" });
  expect(document.activeElement).toBe(document.body);

  const toggle = screen.getByRole("button", { name: "Chat" });
  fireEvent.click(toggle);
  await waitFor(() => expect(screen.queryByRole("complementary", { name: "Chat" })).toBeNull());
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Message" })),
  );
  expect(useChatPanelStore.getState().focusPending).toBe(false);
});

it("resizes from its left edge with the arrow keys and remembers the width", async () => {
  setChatPanelOpen(true);
  renderPanel();
  const panel = await screen.findByRole("complementary", { name: "Chat" });
  const handle = screen.getByRole("separator", { name: "Resize chat panel" });
  expect(panel.style.width).toBe("384px");
  fireEvent.keyDown(handle, { key: "ArrowLeft" });
  expect(panel.style.width).toBe("400px");
  expect(handle.getAttribute("aria-valuenow")).toBe("400");
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  expect(panel.style.width).toBe("368px");
  expect(localStorage.getItem("fdrive.chat.width")).toBe("368");
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
  mocks.client.stat.mockResolvedValue(entry("/Inbox/a.txt", "file"));
  fireEvent.click(link);
  await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/files/Inbox?select=a.txt"));

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

it("opens a path the assistant wrote in code, finding its stored spelling, and says when it is missing", async () => {
  setChatPanelOpen(true);
  setCurrentChatId("c1");
  const stored = "/Work/Va\u0308stervik Energi";
  mocks.client.chat.mockResolvedValue(
    chat({
      messages: [
        {
          id: "m2",
          role: "assistant",
          parts: [
            { kind: "text", text: "See `/Work/Västervik Energi` and `/Norrköping Airport`." },
          ],
          references: [],
          location: null,
          createdAt: "2026-09-18T10:00:01.000Z",
        },
      ],
    }),
  );
  mocks.client.stat.mockImplementation(async (path: string) => {
    if (path === "/Work") return entry("/Work", "dir");
    throw notFound();
  });
  mocks.client.list.mockResolvedValue({ path: "/Work", entries: [entry(stored, "dir")] });
  renderPanel();

  fireEvent.click(await screen.findByRole("link", { name: "/Work/Västervik Energi" }));
  await waitFor(() =>
    expect(mocks.push).toHaveBeenCalledWith(
      `/files/Work/${encodeURIComponent("Va\u0308stervik Energi")}`,
    ),
  );
  expect(mocks.client.list).toHaveBeenCalledWith("/Work");

  fireEvent.click(screen.getByRole("link", { name: "/Norrköping Airport" }));
  await waitFor(() =>
    expect(mocks.error).toHaveBeenCalledWith("Could not find /Norrköping Airport."),
  );
  expect(mocks.push).toHaveBeenCalledTimes(1);
});

it("shows the open folder the next message can use, Home at the root", async () => {
  setChatPanelOpen(true);
  renderPanel();
  const attached = await screen.findByRole("group", { name: "Attached to the next message" });
  expect(attached.textContent).toBe("Inbox");
  expect(screen.getByTitle("The assistant can use /Inbox and everything in it")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Remove Inbox" })).toBeNull();
  expect(screen.getByRole("textbox", { name: "Message" }).getAttribute("placeholder")).toBe(
    "Ask about this folder, or drop files here…",
  );

  cleanup();
  mocks.pathname = "/files";
  renderPanel();
  expect(
    (await screen.findByRole("group", { name: "Attached to the next message" })).textContent,
  ).toBe("Home");
});

it("offers chat only on folder pages, keeping the panel open for the next one", async () => {
  mocks.client.chat.mockResolvedValue(chat({ state: "awaiting_approval" }));
  setCurrentChatId("c1");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { rerender } = render(view(queryClient));
  // Closed in a folder: the toolbar button, saying a card waits.
  expect(
    await screen.findByRole("button", { name: "Chat", description: "Waiting for you" }),
  ).toBeTruthy();

  mocks.pathname = "/system/ai";
  rerender(view(queryClient));
  expect(screen.queryByRole("button", { name: "Chat" })).toBeNull();
  fireEvent.keyDown(window, { key: "k", shiftKey: true, metaKey: true });
  expect(localStorage.getItem("fdrive.chat.open")).toBeNull();

  // Open, then away from folders: the panel hides and comes back with the next folder.
  act(() => setChatPanelOpen(true));
  expect(screen.queryByRole("complementary", { name: "Chat" })).toBeNull();
  mocks.pathname = "/files/Docs";
  rerender(view(queryClient));
  expect(await screen.findByRole("complementary", { name: "Chat" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Chat" }).getAttribute("aria-expanded")).toBe("true");
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

  // Back at ten, every chip shows on its own again, next to the open folder.
  fireEvent.click(screen.getByRole("button", { name: "Remove f1.pdf" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: /items$/ })).toBeNull());
  expect(attached.querySelectorAll('[data-slot="badge"]')).toHaveLength(11);

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

it("opens as a sheet on narrow screens, without an empty state, and toggles with the keyboard shortcut", async () => {
  mocks.mobile = true;
  renderPanel();
  const toggle = await screen.findByRole("button", { name: "Chat" });
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(toggle);

  const sheet = await screen.findByRole("dialog");
  expect(screen.queryByRole("complementary", { name: "Chat" })).toBeNull();
  expect(within(sheet).getByRole("button", { name: "Chats" }).textContent).toBe("New chat");
  expect(within(sheet).getByRole("textbox", { name: "Message" })).toBeTruthy();
  expect(within(sheet).queryByRole("log")).toBeNull();
  expect(within(sheet).queryByText("Ask about your files")).toBeNull();

  fireEvent.keyDown(window, { key: "k", shiftKey: true, metaKey: true });
  await waitFor(() => expect(localStorage.getItem("fdrive.chat.open")).toBe("false"));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.keyDown(window, { key: "K", shiftKey: true, ctrlKey: true });
  expect(await screen.findByRole("dialog")).toBeTruthy();
});
