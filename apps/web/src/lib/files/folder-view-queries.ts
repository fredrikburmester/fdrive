"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { accountTransition } from "@/lib/account/transition";
import { snapshotTabApiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/keys";
import { resolveFolderView } from "./folder-view";
import { useDefaultView } from "./use-default-view";
import type { ViewMode } from "./view-mode";

function useScope() {
  const [scope] = useState(() => ({
    client: snapshotTabApiClient(),
    generation: accountTransition.getSnapshot().generation,
  }));
  return scope;
}

function isCurrent(generation: number) {
  const current = accountTransition.getSnapshot();
  return !current.pending && current.generation === generation;
}

export function useFolderView(path: string, identityId: string | undefined) {
  const scope = useScope();
  const queryClient = useQueryClient();
  const [globalDefault, setGlobalDefault] = useDefaultView();
  const busy = useRef(false);
  const query = useQuery({
    queryKey: queryKeys.folderViews.path(identityId ?? "", path),
    queryFn: () => scope.client.getFolderView(path),
    enabled: identityId !== undefined,
    staleTime: 0,
  });
  const mutation = useMutation({
    mutationFn: async (input: { path: string; mode: ViewMode | null }) => {
      if (!isCurrent(scope.generation)) throw new Error("Login changed.");
      return input.mode === null
        ? scope.client.removeFolderView({ path: input.path })
        : scope.client.setFolderView({ path: input.path, mode: input.mode });
    },
    onMutate: async (input) => {
      const key = queryKeys.folderViews.path(identityId ?? "", input.path);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData(key);
      if (isCurrent(scope.generation)) {
        queryClient.setQueryData(key, {
          view: input.mode === null ? null : { path: input.path, mode: input.mode },
        });
      }
      return { key, previous };
    },
    onError: (_error, _input, context) => {
      if (!isCurrent(scope.generation)) return;
      if (context) queryClient.setQueryData(context.key, context.previous);
      toast.error("Could not save the folder view.");
    },
    onSettled: async (_data, _error, _input, context) => {
      if (isCurrent(scope.generation) && context) {
        await queryClient.invalidateQueries({ queryKey: context.key });
      }
      busy.current = false;
    },
  });
  const mode = resolveFolderView(path, query.data?.view, globalDefault);
  function save(next: ViewMode | null) {
    if (busy.current || !query.isSuccess || !isCurrent(scope.generation)) return;
    busy.current = true;
    mutation.mutate({ path, mode: next });
  }
  return {
    mode,
    pinned: query.data?.view != null,
    loading: query.isPending,
    disabled: !query.isSuccess || mutation.isPending,
    error: query.isError,
    retry: () => void query.refetch(),
    setMode: (next: ViewMode) => save(next),
    useDefault: () => save(null),
    makeDefault: () => setGlobalDefault(mode),
  };
}

export function useResetFolderViews() {
  const scope = useScope();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => {
      if (!isCurrent(scope.generation)) throw new Error("Login changed.");
      return scope.client.resetFolderViews();
    },
    onSuccess: async () => {
      if (!isCurrent(scope.generation)) return;
      await queryClient.invalidateQueries({ queryKey: queryKeys.folderViews.all() });
      toast.success("All folders now use the default view.");
    },
    onError: () => {
      if (isCurrent(scope.generation)) toast.error("Could not reset folder views.");
    },
  });
}
