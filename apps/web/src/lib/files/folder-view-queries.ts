"use client";

import type { FolderViewResponse } from "@fdrive/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { accountTransition } from "@/lib/account/transition";
import { snapshotTabApiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/keys";
import { resolveFolderSort, resolveFolderView } from "./folder-view";
import type { SortSpec } from "./sorting";
import { useDefaultSort } from "./use-default-sort";
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

/** One part of a folder's pin being written: `null` unpins that part only. */
type PinChange =
  | { readonly path: string; readonly part: "mode"; readonly value: ViewMode | null }
  | { readonly path: string; readonly part: "sort"; readonly value: SortSpec | null };

/** The cached pin after `change`, or `null` once neither part is pinned. */
function applyChange(
  previous: FolderViewResponse | undefined,
  change: PinChange,
): FolderViewResponse {
  const base = previous?.view ?? { path: change.path, mode: null, sort: null };
  const next =
    change.part === "mode" ? { ...base, mode: change.value } : { ...base, sort: change.value };
  return { view: next.mode === null && next.sort == null ? null : next };
}

export function useFolderView(path: string, identityId: string | undefined) {
  const scope = useScope();
  const queryClient = useQueryClient();
  const [globalDefault, setGlobalDefault] = useDefaultView();
  const [globalSort, setGlobalSort] = useDefaultSort();
  const busy = useRef(new Set<string>());
  const query = useQuery({
    queryKey: queryKeys.folderViews.path(identityId ?? "", path),
    queryFn: () => scope.client.getFolderView(path),
    enabled: identityId !== undefined,
    staleTime: 0,
  });
  const mutation = useMutation({
    mutationFn: async (change: PinChange) => {
      if (!isCurrent(scope.generation)) throw new Error("Login changed.");
      if (change.value === null) {
        return scope.client.removeFolderView({ path: change.path, part: change.part });
      }
      return change.part === "mode"
        ? scope.client.setFolderView({ path: change.path, mode: change.value })
        : scope.client.setFolderView({ path: change.path, sort: change.value });
    },
    onMutate: async (change) => {
      const key = queryKeys.folderViews.path(identityId ?? "", change.path);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<FolderViewResponse>(key);
      if (isCurrent(scope.generation)) {
        queryClient.setQueryData(key, applyChange(previous, change));
      }
      return { key, previous };
    },
    onError: (_error, change, context) => {
      if (!isCurrent(scope.generation)) return;
      if (context) queryClient.setQueryData(context.key, context.previous);
      toast.error(
        change.part === "mode"
          ? "Could not save the folder view."
          : "Could not save the folder sort.",
      );
    },
    onSettled: async (_data, _error, change, context) => {
      if (isCurrent(scope.generation) && context) {
        await queryClient.invalidateQueries({ queryKey: context.key });
      }
      busy.current.delete(change.path);
    },
  });
  const pin = query.data?.view;
  const mode = resolveFolderView(path, pin, globalDefault);
  const sort = resolveFolderSort(path, pin, globalSort);
  function save(change: PinChange) {
    if (busy.current.has(path) || !query.isSuccess || !isCurrent(scope.generation)) return;
    busy.current.add(path);
    mutation.mutate(change);
  }
  return {
    mode,
    sort,
    pinned: pin?.mode != null,
    sortPinned: pin?.sort != null,
    loading: query.isPending,
    disabled: !query.isSuccess || busy.current.has(path),
    error: query.isError,
    retry: () => void query.refetch(),
    setMode: (next: ViewMode) => save({ path, part: "mode", value: next }),
    useDefault: () => save({ path, part: "mode", value: null }),
    makeDefault: () => setGlobalDefault(mode),
    setSort: (next: SortSpec) => save({ path, part: "sort", value: next }),
    useDefaultSort: () => save({ path, part: "sort", value: null }),
    makeDefaultSort: () => setGlobalSort(sort),
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
      toast.success("All folders now use the default view and sort.");
    },
    onError: () => {
      if (isCurrent(scope.generation)) toast.error("Could not reset folder views.");
    },
  });
}
