import {
  type Chat,
  chatActionRoute,
  chatCancelRoute,
  chatMessagesRoute,
  chatRoute,
  ROUTES,
} from "@fdrive/contracts";
import type { StorageProvider } from "@fdrive/core";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import type { Principal } from "../../auth/principal.js";
import { loadConfig } from "../../config.js";
import { ApiHttpError } from "../../errors.js";
import { registerChatRoutes } from "./routes.ts";
import type { ChatService } from "./service.ts";

const WRITE_HEADERS = { "content-type": "application/json", "x-requested-with": "fdrive" };

const CHAT: Chat = {
  id: "chat-1",
  title: "Taxes",
  createdAt: "2026-09-18T10:00:00.000Z",
  updatedAt: "2026-09-18T10:00:00.000Z",
  lastMessageAt: "2026-09-18T10:00:00.000Z",
  state: "idle",
  share: { contents: true, otherFileNames: true },
  references: [{ path: "/Inbox/a.pdf", missing: false }],
  messages: [],
};

function buildApp() {
  const principal: Principal = {
    accountId: "323e4567-e89b-42d3-a456-426614174000",
    identityId: "223e4567-e89b-42d3-a456-426614174000",
    username: "alice",
    storage: {} as StorageProvider,
    isAdmin: false,
  };
  const chat = {
    list: vi.fn(async () => ({
      chats: [
        { ...CHAT, state: undefined, share: undefined, references: undefined, messages: undefined },
      ],
    })),
    create: vi.fn(async () => CHAT),
    get: vi.fn(async (_principal: Principal, id: string) => {
      if (id !== CHAT.id) throw new ApiHttpError("not_found", "That chat does not exist.");
      return CHAT;
    }),
    rename: vi.fn(async () => ({ ...CHAT, title: "Renamed" })),
    delete: vi.fn(async () => {}),
    send: vi.fn(async () => ({ ...CHAT, state: "running" as const })),
    cancel: vi.fn(async () => CHAT),
    act: vi.fn(async () => ({ ...CHAT, state: "running" as const })),
    settled: vi.fn(async () => {}),
  } satisfies ChatService;
  const app = createApp({
    config: loadConfig({
      DATABASE_URL: "postgres://localhost/fdrive",
      SFTPGO_URL: "http://sftpgo.test",
      FDRIVE_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    }),
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as Logger,
    version: "test",
    startedAt: new Date(0),
    principalResolver: async () => principal,
    registerRoutes: (groups) => registerChatRoutes(groups.authed, chat),
  });
  return { app, chat, principal };
}

function post(body: unknown, method = "POST"): RequestInit {
  return { method, headers: WRITE_HEADERS, body: JSON.stringify(body) };
}

describe("chat routes", () => {
  it("lists, creates, reads, renames and deletes chats for the caller", async () => {
    const { app, chat, principal } = buildApp();

    const list = await app.request(ROUTES.ai.chats);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { chats: unknown[] }).chats[0]).toMatchObject({
      id: "chat-1",
      title: "Taxes",
    });

    const created = await app.request(
      ROUTES.ai.chats,
      post({ share: { contents: false, otherFileNames: true } }),
    );
    expect(created.status).toBe(201);
    expect(chat.create).toHaveBeenCalledWith(principal, {
      share: { contents: false, otherFileNames: true },
    });

    const got = await app.request(chatRoute("chat-1"));
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual(CHAT);
    expect((await app.request(chatRoute("other"))).status).toBe(404);

    const renamed = await app.request(chatRoute("chat-1"), post({ title: "  Renamed " }, "PATCH"));
    expect(renamed.status).toBe(200);
    expect(chat.rename).toHaveBeenCalledWith(principal, "chat-1", { title: "Renamed" });

    const deleted = await app.request(chatRoute("chat-1"), {
      method: "DELETE",
      headers: WRITE_HEADERS,
    });
    expect(deleted.status).toBe(204);
    expect(chat.delete).toHaveBeenCalledWith(principal, "chat-1");
  });

  it("sends messages, cancels and answers cards, accepting the work for later", async () => {
    const { app, chat, principal } = buildApp();

    const sent = await app.request(
      chatMessagesRoute("chat-1"),
      post({ text: "What is this?", references: ["/Inbox/a.pdf"], location: "/Inbox" }),
    );
    expect(sent.status).toBe(202);
    expect(((await sent.json()) as { state: string }).state).toBe("running");
    expect(chat.send).toHaveBeenCalledWith(principal, "chat-1", {
      text: "What is this?",
      references: ["/Inbox/a.pdf"],
      location: "/Inbox",
    });

    expect((await app.request(chatCancelRoute("chat-1"), post({}))).status).toBe(200);
    expect(chat.cancel).toHaveBeenCalledWith(principal, "chat-1");

    const applied = await app.request(
      chatActionRoute("chat-1", "card-1"),
      post({ decision: "apply", edits: { paths: ["/Inbox/a.pdf"] } }),
    );
    expect(applied.status).toBe(202);
    expect(chat.act).toHaveBeenCalledWith(principal, "chat-1", "card-1", {
      decision: "apply",
      edits: { paths: ["/Inbox/a.pdf"] },
    });
  });

  it("rejects bodies the contracts refuse before touching the service", async () => {
    const { app, chat } = buildApp();

    expect((await app.request(chatMessagesRoute("chat-1"), post({ text: "   " }))).status).toBe(
      400,
    );
    expect(
      (await app.request(chatActionRoute("chat-1", "c"), post({ decision: "maybe" }))).status,
    ).toBe(400);
    expect((await app.request(chatRoute("chat-1"), post({ title: "" }, "PATCH"))).status).toBe(400);
    expect(chat.send).not.toHaveBeenCalled();
    expect(chat.act).not.toHaveBeenCalled();
    expect(chat.rename).not.toHaveBeenCalled();
  });
});
