"use client";

import type { FolderViewResponse } from "@fdrive/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { toast } from "sonner";
import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/keys";
import { resolveFolderSort, resolveFolderView } from "./folder-view";
import type { SortSpec } from "./sorting";
import { useDefaultSort } from "./use-default-sort";
import { useDefaultView } from "./use-default-view";
import type { ViewMode } from "./view-mode";

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

export function useFolderView(path: string) {
  const queryClient = useQueryClient();
  const [globalDefault, setGlobalDefault] = useDefaultView();
  const [globalSort, setGlobalSort] = useDefaultSort();
  const busy = useRef(new Set<string>());
  const query = useQuery({
    queryKey: queryKeys.folderViews.path(path),
    queryFn: () => apiClient.getFolderView(path),
    staleTime: 0,
  });
  const mutation = useMutation({
    mutationFn: async (change: PinChange) => {
      if (change.value === null) {
        return apiClient.removeFolderView({ path: change.path, part: change.part });
      }
      return change.part === "mode"
        ? apiClient.setFolderView({ path: change.path, mode: change.value })
        : apiClient.setFolderView({ path: change.path, sort: change.value });
    },
    onMutate: async (change) => {
      const key = queryKeys.folderViews.path(change.path);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<FolderViewResponse>(key);
      queryClient.setQueryData(key, applyChange(previous, change));
      return { key, previous };
    },
    onError: (_error, change, context) => {
      if (context) queryClient.setQueryData(context.key, context.previous);
      toast.error(
        change.part === "mode"
          ? "Could not save the folder view."
          : "Could not save the folder sort.",
      );
    },
    onSettled: async (_data, _error, change, context) => {
      if (context) await queryClient.invalidateQueries({ queryKey: context.key });
      busy.current.delete(change.path);
    },
  });
  const pin = query.data?.view;
  const mode = resolveFolderView(path, pin, globalDefault);
  const sort = resolveFolderSort(path, pin, globalSort);
  function save(change: PinChange) {
    if (busy.current.has(path) || !query.isSuccess) return;
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
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiClient.resetFolderViews(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.folderViews.all() });
      toast.success("All folders now use the default view and sort.");
    },
    onError: () => {
      toast.error("Could not reset folder views.");
    },
  });
}
