// @vitest-environment jsdom
import type { Chat } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  client: {
    aiStatus: vi.fn(),
    encryptedFolder: vi.fn(),
    chat: vi.fn(),
  },
  pathname: "/files/Inbox",
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: mocks.client,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ push: vi.fn() }),
}));

const { ChatToggle } = await import("./chat-toggle");
const { readChatOpen, setChatPanelOpen, setCurrentChatId, useChatPanelStore } = await import(
  "@/lib/ai/chat-panel"
);
const { startDragSession, endDragSession, INTERNAL_DND_TYPE } = await import("@/lib/dnd");

function chat(state: Chat["state"]): Chat {
  return {
    id: "c1",
    title: "What are these?",
    createdAt: "2026-09-18T10:00:00.000Z",
    updatedAt: "2026-09-18T10:00:00.000Z",
    lastMessageAt: "2026-09-18T10:00:00.000Z",
    state,
    share: { contents: true, otherFileNames: true },
    references: [],
    messages: [],
  };
}

function renderToggle() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ChatToggle />
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

/** Waits until every request the button started has answered and React has seen the answers. */
async function settled(queryClient: QueryClient) {
  await waitFor(() => expect(mocks.client.aiStatus).toHaveBeenCalled());
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** What a drag from a listing carries, as far as the button reads it. */
function listingDrag(paths: readonly string[]) {
  return {
    types: [INTERNAL_DND_TYPE],
    getData: () => JSON.stringify(paths),
    setData: () => {},
    dropEffect: "none",
  };
}

beforeEach(() => {
  mocks.client.aiStatus.mockResolvedValue({ provider: "anthropic", organize: true, chat: true });
  mocks.client.encryptedFolder.mockResolvedValue({ folder: null });
  mocks.client.chat.mockResolvedValue(chat("idle"));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  useChatPanelStore.getState().clearChips();
  useChatPanelStore.setState({ focusPending: false });
  mocks.pathname = "/files/Inbox";
});

it("renders nothing while AI chat is off, away from folders, and in an encrypted folder", async () => {
  mocks.client.aiStatus.mockResolvedValue({ provider: null, organize: false, chat: false });
  let view = renderToggle();
  await settled(view.queryClient);
  expect(screen.queryByRole("button", { name: "Chat" })).toBeNull();
  expect(screen.queryByRole("status")).toBeNull();
  // Nothing asks about the folder until chat is known to be on.
  expect(mocks.client.encryptedFolder).not.toHaveBeenCalled();

  cleanup();
  mocks.client.aiStatus.mockResolvedValue({ provider: "anthropic", organize: true, chat: true });
  mocks.pathname = "/system/ai";
  view = renderToggle();
  await settled(view.queryClient);
  expect(screen.queryByRole("button", { name: "Chat" })).toBeNull();
  expect(mocks.client.encryptedFolder).not.toHaveBeenCalled();

  cleanup();
  mocks.pathname = "/files/Vault";
  mocks.client.encryptedFolder.mockResolvedValue({ folder: { path: "/Vault" } });
  view = renderToggle();
  await waitFor(() => expect(mocks.client.encryptedFolder).toHaveBeenCalledWith("/Vault"));
  await settled(view.queryClient);
  expect(screen.queryByRole("button", { name: "Chat" })).toBeNull();
});

it("opens and closes the chat panel and says which it is", async () => {
  renderToggle();
  const button = await screen.findByRole("button", { name: "Chat" });
  expect(button.getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByRole("status").textContent).toBe("");

  fireEvent.click(button);
  expect(readChatOpen(localStorage)).toBe(true);
  expect(button.getAttribute("aria-expanded")).toBe("true");

  fireEvent.click(button);
  expect(readChatOpen(localStorage)).toBe(false);
  expect(button.getAttribute("aria-expanded")).toBe("false");
});

it("shows a spinner while a reply is written and a dot while a card waits, only with the panel closed", async () => {
  mocks.client.chat.mockResolvedValue(chat("running"));
  setCurrentChatId("c1");
  let view = renderToggle();
  const answering = await screen.findByRole("button", { name: "Chat", description: "Answering…" });
  expect(mocks.client.chat).toHaveBeenCalledWith("c1");
  expect(answering.querySelector(".animate-spin")).not.toBeNull();
  expect(view.container.querySelector('[data-slot="chat-toggle-dot"]')).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("Answering…");

  cleanup();
  mocks.client.chat.mockResolvedValue(chat("awaiting_approval"));
  view = renderToggle();
  const waiting = await screen.findByRole("button", {
    name: "Chat",
    description: "Waiting for you",
  });
  expect(waiting.querySelector(".animate-spin")).toBeNull();
  expect(view.container.querySelector('[data-slot="chat-toggle-dot"]')).not.toBeNull();

  // The open panel says what the chat is doing itself, so the button goes quiet.
  fireEvent.click(waiting);
  expect(view.container.querySelector('[data-slot="chat-toggle-dot"]')).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("");
});

it("stays a plain sparkle for an idle chat and before any chat exists", async () => {
  const { container, queryClient } = renderToggle();
  const button = await screen.findByRole("button", { name: "Chat" });
  // No current chat: there is nothing to ask the server about.
  expect(mocks.client.chat).not.toHaveBeenCalled();
  expect(button.querySelector("svg")).not.toBeNull();
  expect(button.querySelector(".animate-spin")).toBeNull();

  act(() => setCurrentChatId("c1"));
  await waitFor(() => expect(mocks.client.chat).toHaveBeenCalledWith("c1"));
  await settled(queryClient);
  expect(button.querySelector(".animate-spin")).toBeNull();
  expect(container.querySelector('[data-slot="chat-toggle-dot"]')).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("");
});

it("takes items dragged from a listing, marked and hinted while they hover, and opens the panel with them", async () => {
  renderToggle();
  const button = await screen.findByRole("button", { name: "Chat" });
  const dataTransfer = listingDrag(["/Inbox/b.txt"]);

  // Nothing dragged from a listing: the button is no drop target.
  fireEvent.dragOver(button, { dataTransfer });
  expect(button.getAttribute("data-dropping")).toBeNull();
  expect(dataTransfer.dropEffect).toBe("none");

  act(() => startDragSession(["/Inbox/b.txt"]));
  fireEvent.dragOver(button, { dataTransfer });
  expect(button.getAttribute("data-dropping")).toBe("true");
  expect(button.classList.contains("ring-ring")).toBe(true);
  expect(dataTransfer.dropEffect).toBe("copy");
  expect((await screen.findAllByText("Drop to add to chat")).length).toBeGreaterThan(0);

  fireEvent.dragLeave(button);
  expect(button.getAttribute("data-dropping")).toBeNull();
  expect(button.classList.contains("ring-ring")).toBe(false);

  fireEvent.dragOver(button, { dataTransfer });
  fireEvent.drop(button, { dataTransfer });
  act(() => endDragSession());
  expect(button.getAttribute("data-dropping")).toBeNull();
  expect(useChatPanelStore.getState().chips).toEqual(["/Inbox/b.txt"]);
  expect(readChatOpen(localStorage)).toBe(true);
  expect(button.getAttribute("aria-expanded")).toBe("true");
});

it("ignores a drop that carries no listing paths", async () => {
  renderToggle();
  const button = await screen.findByRole("button", { name: "Chat" });
  act(() => startDragSession(["/Inbox/b.txt"]));
  fireEvent.dragOver(button, { dataTransfer: listingDrag(["/Inbox/b.txt"]) });
  fireEvent.drop(button, {
    dataTransfer: { types: ["Files"], getData: () => "", setData: () => {}, dropEffect: "none" },
  });
  act(() => endDragSession());
  expect(button.getAttribute("data-dropping")).toBeNull();
  expect(useChatPanelStore.getState().chips).toEqual([]);
  expect(readChatOpen(localStorage)).toBe(false);
});

it("follows the panel when something else opens or closes it", async () => {
  renderToggle();
  const button = await screen.findByRole("button", { name: "Chat" });
  act(() => setChatPanelOpen(true));
  expect(button.getAttribute("aria-expanded")).toBe("true");
  act(() => setChatPanelOpen(false));
  expect(button.getAttribute("aria-expanded")).toBe("false");
});
