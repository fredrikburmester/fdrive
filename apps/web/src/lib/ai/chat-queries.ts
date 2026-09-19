"use client";

import type {
  Chat,
  ChatActionRequest,
  ChatCreateRequest,
  ChatMessageRequest,
  ChatRenameRequest,
} from "@fdrive/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/keys";

/** While a reply is being written, how often the transcript is refreshed. */
export const CHAT_POLL_MS = 1000;

export function useChats(enabled = true) {
  return useQuery({
    queryKey: queryKeys.ai.chats(),
    queryFn: () => apiClient.chats(),
    enabled,
    staleTime: 10_000,
  });
}

/** One chat with its transcript, polled while the assistant is answering. */
export function useChat(id: string | null) {
  return useQuery({
    queryKey: queryKeys.ai.chat(id ?? ""),
    // `enabled` keeps this from running without an id.
    queryFn: () => apiClient.chat(id as string),
    enabled: id !== null,
    refetchInterval: (query) => (query.state.data?.state === "running" ? CHAT_POLL_MS : false),
  });
}

/** Stores a chat in the cache and refreshes the list it belongs to. */
function useChatSetter() {
  const client = useQueryClient();
  return (chat: Chat) => {
    client.setQueryData(queryKeys.ai.chat(chat.id), chat);
    void client.invalidateQueries({ queryKey: queryKeys.ai.chats() });
  };
}

export function useCreateChat() {
  const set = useChatSetter();
  return useMutation({
    mutationFn: (request: ChatCreateRequest = {}) => apiClient.createChat(request),
    onSuccess: set,
  });
}

export function useSendChatMessage() {
  const set = useChatSetter();
  return useMutation({
    mutationFn: ({ id, request }: { id: string; request: ChatMessageRequest }) =>
      apiClient.sendChatMessage(id, request),
    onSuccess: set,
  });
}

export function useCancelChat() {
  const set = useChatSetter();
  return useMutation({
    mutationFn: (id: string) => apiClient.cancelChat(id),
    onSuccess: set,
  });
}

export function useActOnChat() {
  const set = useChatSetter();
  return useMutation({
    mutationFn: ({
      id,
      actionId,
      request,
    }: {
      id: string;
      actionId: string;
      request: ChatActionRequest;
    }) => apiClient.actOnChat(id, actionId, request),
    onSuccess: set,
  });
}

export function useRenameChat() {
  const set = useChatSetter();
  return useMutation({
    mutationFn: ({ id, request }: { id: string; request: ChatRenameRequest }) =>
      apiClient.renameChat(id, request),
    onSuccess: set,
  });
}

export function useDeleteChat() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.deleteChat(id),
    onSuccess: (_result, id) => {
      client.removeQueries({ queryKey: queryKeys.ai.chat(id) });
      void client.invalidateQueries({ queryKey: queryKeys.ai.chats() });
    },
  });
}
