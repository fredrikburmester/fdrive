import {
  Chat,
  ChatActionRequest,
  ChatCreateRequest,
  ChatListResponse,
  ChatMessageRequest,
  ChatRenameRequest,
  OkResponse,
  ROUTES,
} from "@fdrive/contracts";
import type { AuthedHono } from "../../app.js";
import { withoutApiV1Prefix } from "../../auth/routes.js";
import { parseBody } from "../../fs/routes.js";
import type { ChatService } from "./service.ts";

/** `/ai/chats/*` for every signed-in person. */
export function registerChatRoutes(authed: AuthedHono, chat: ChatService): void {
  const base = withoutApiV1Prefix(ROUTES.ai.chats);

  authed.get(base, async (c) =>
    c.json(ChatListResponse.parse(await chat.list(c.get("principal")))),
  );

  authed.post(base, async (c) => {
    const request = await parseBody(ChatCreateRequest, c);
    return c.json(Chat.parse(await chat.create(c.get("principal"), request)), 201);
  });

  authed.get(`${base}/:id`, async (c) =>
    c.json(Chat.parse(await chat.get(c.get("principal"), c.req.param("id")))),
  );

  authed.patch(`${base}/:id`, async (c) => {
    const request = await parseBody(ChatRenameRequest, c);
    return c.json(Chat.parse(await chat.rename(c.get("principal"), c.req.param("id"), request)));
  });

  authed.delete(`${base}/:id`, async (c) => {
    await chat.delete(c.get("principal"), c.req.param("id"));
    return c.json(OkResponse.parse({ ok: true }));
  });

  authed.post(`${base}/:id/messages`, async (c) => {
    const request = await parseBody(ChatMessageRequest, c);
    return c.json(Chat.parse(await chat.send(c.get("principal"), c.req.param("id"), request)), 202);
  });

  authed.post(`${base}/:id/cancel`, async (c) =>
    c.json(Chat.parse(await chat.cancel(c.get("principal"), c.req.param("id")))),
  );

  authed.post(`${base}/:id/actions/:actionId`, async (c) => {
    const request = await parseBody(ChatActionRequest, c);
    return c.json(
      Chat.parse(
        await chat.act(c.get("principal"), c.req.param("id"), c.req.param("actionId"), request),
      ),
      202,
    );
  });
}
