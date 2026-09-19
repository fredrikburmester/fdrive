import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../index.js";
import { aiChatMessages, aiChatReferences, aiChats } from "../schema/app.js";
import type { AiChat, AiChatMessage, AiChatReference, AiChatRepo, AiChatRole } from "./types.js";

function toChat(row: typeof aiChats.$inferSelect): AiChat {
  return {
    id: row.id,
    identityId: row.identityId,
    title: row.title,
    share: row.share,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastMessageAt: row.lastMessageAt,
  };
}

function toMessage(row: typeof aiChatMessages.$inferSelect): AiChatMessage {
  return {
    id: row.id,
    chatId: row.chatId,
    ordinal: row.ordinal,
    role: row.role as AiChatRole,
    parts: row.parts,
    references: row.references,
    location: row.location,
    createdAt: row.createdAt,
  };
}

function toReference(row: typeof aiChatReferences.$inferSelect): AiChatReference {
  return { path: row.path, missing: row.missing, addedAt: row.addedAt };
}

export function createAiChatRepo(db: Db): AiChatRepo {
  const owned = (identityId: string, id: string) =>
    and(eq(aiChats.identityId, identityId), eq(aiChats.id, id));

  return {
    async create(input) {
      const [row] = await db
        .insert(aiChats)
        .values({ identityId: input.identityId, title: input.title, share: input.share })
        .returning();
      if (row === undefined) throw new Error("chat insert returned no row");
      return toChat(row);
    },

    async get(identityId, id) {
      const [row] = await db.select().from(aiChats).where(owned(identityId, id));
      return row === undefined ? null : toChat(row);
    },

    async list(identityId, limit) {
      const rows = await db
        .select()
        .from(aiChats)
        .where(eq(aiChats.identityId, identityId))
        .orderBy(desc(aiChats.lastMessageAt), desc(aiChats.id))
        .limit(limit);
      return rows.map(toChat);
    },

    async rename(identityId, id, title) {
      const [row] = await db
        .update(aiChats)
        .set({ title, updatedAt: sql`now()` })
        .where(owned(identityId, id))
        .returning();
      return row === undefined ? null : toChat(row);
    },

    async delete(identityId, id) {
      const rows = await db
        .delete(aiChats)
        .where(owned(identityId, id))
        .returning({ id: aiChats.id });
      return rows.length > 0;
    },

    async prune(identityId, options) {
      const rows = await db
        .delete(aiChats)
        .where(
          sql`${aiChats.identityId} = ${identityId} and (
            ${aiChats.lastMessageAt} < ${options.idleBefore}
            or ${aiChats.id} in (
              select id from "app"."ai_chats"
              where identity_id = ${identityId}
              order by last_message_at desc, id desc
              offset ${options.keep}
            )
          )`,
        )
        .returning({ id: aiChats.id });
      return rows.length;
    },

    async messages(chatId) {
      const rows = await db
        .select()
        .from(aiChatMessages)
        .where(eq(aiChatMessages.chatId, chatId))
        .orderBy(aiChatMessages.ordinal);
      return rows.map(toMessage);
    },

    async appendMessage(chatId, input) {
      return db.transaction(async (tx) => {
        const [chat] = await tx
          .select({ id: aiChats.id })
          .from(aiChats)
          .where(eq(aiChats.id, chatId))
          .for("update");
        if (chat === undefined) throw new Error("chat does not exist");
        const [row] = await tx
          .insert(aiChatMessages)
          .values({
            chatId,
            ordinal: sql`(select coalesce(max(ordinal), 0) + 1 from "app"."ai_chat_messages" where chat_id = ${chatId})`,
            role: input.role,
            parts: [...input.parts],
            references: [...input.references],
            location: input.location,
          })
          .returning();
        if (row === undefined) throw new Error("message insert returned no row");
        await tx
          .update(aiChats)
          .set({ lastMessageAt: row.createdAt, updatedAt: row.createdAt })
          .where(eq(aiChats.id, chatId));
        return toMessage(row);
      });
    },

    async updateMessageParts(messageId, parts) {
      await db
        .update(aiChatMessages)
        .set({ parts: [...parts] })
        .where(eq(aiChatMessages.id, messageId));
    },

    async references(chatId) {
      const rows = await db
        .select()
        .from(aiChatReferences)
        .where(eq(aiChatReferences.chatId, chatId))
        .orderBy(aiChatReferences.addedAt, aiChatReferences.path);
      return rows.map(toReference);
    },

    async addReferences(chatId, paths) {
      if (paths.length === 0) return;
      const [chat] = await db
        .select({ identityId: aiChats.identityId })
        .from(aiChats)
        .where(eq(aiChats.id, chatId));
      if (chat === undefined) throw new Error("chat does not exist");
      await db
        .insert(aiChatReferences)
        .values([...new Set(paths)].map((path) => ({ chatId, identityId: chat.identityId, path })))
        .onConflictDoUpdate({
          target: [aiChatReferences.chatId, aiChatReferences.path],
          set: { missing: false },
        });
    },

    async moveReferences(identityId, oldPath, newPath, isDir) {
      if (oldPath === newPath) return;
      const oldPrefix = `${oldPath}/`;
      const newPrefix = `${newPath}/`;
      await db.transaction(async (tx) => {
        // A chat that already references the destination keeps one row: the moved one wins.
        await tx.execute(sql`
          delete from "app"."ai_chat_references" f
          using "app"."ai_chat_references" s
          where f.identity_id = ${identityId} and s.identity_id = ${identityId}
            and f.chat_id = s.chat_id and f.path <> s.path
            and (
              (s.path = ${oldPath} and f.path = ${newPath})
              or (${isDir} and starts_with(s.path, ${oldPrefix}) and f.path = ${newPrefix} || substr(s.path, char_length(${oldPrefix}) + 1))
            )
        `);
        await tx.execute(sql`
          update "app"."ai_chat_references"
          set path = case when path = ${oldPath} then ${newPath}
                     else ${newPrefix} || substr(path, char_length(${oldPrefix}) + 1) end
          where identity_id = ${identityId}
            and (path = ${oldPath} or (${isDir} and starts_with(path, ${oldPrefix})))
        `);
      });
    },

    async markReferencesMissing(identityId, path, isDir) {
      const prefix = `${path}/`;
      await db.execute(sql`
        update "app"."ai_chat_references"
        set missing = true
        where identity_id = ${identityId}
          and (path = ${path} or (${isDir} and starts_with(path, ${prefix})))
      `);
    },
  };
}
