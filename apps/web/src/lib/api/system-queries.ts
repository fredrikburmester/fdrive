"use client";

import type {
  AdminProviderUpdateRequest,
  AdminUserCreateRequest,
  AdminUserUpdateRequest,
  FeaturesUpdateRequest,
  IndexerClearRequest,
  IndexerReindexRequest,
  IndexerSettingsUpdateRequest,
  IndexerStats,
  IndexerThumbnailsRebuildRequest,
  OcrOriginalRestoreRequest,
  OcrSettingsUpdateRequest,
  SetupCompleteRequest,
  SystemActivityId,
} from "@fdrive/contracts";
import {
  keepPreviousData,
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { apiClient } from "./client";
import { queryKeys } from "./keys";

/** How often the System pages re-poll their sidecar status while mounted. */
const SYSTEM_REFETCH_INTERVAL_MS = 5000;
const MAINTENANCE_KEY = ["system", "maintenance"];

export function useSystemFeatures() {
  return useQuery({
    queryKey: queryKeys.system.features(),
    queryFn: () => apiClient.systemFeatures(),
    refetchInterval: SYSTEM_REFETCH_INTERVAL_MS,
  });
}

export function useUpdateFeatures() {
  const client = useQueryClient();
  return useMutation({
    meta: { systemActivity: ["features"], systemActivityBackground: true },
    mutationFn: (input: FeaturesUpdateRequest) => apiClient.systemUpdateFeatures(input),
    onSuccess: (data) => {
      client.setQueryData(queryKeys.system.features(), data);
      void client.invalidateQueries({ queryKey: ["search"] });
      void client.invalidateQueries({ queryKey: ["system"] });
    },
  });
}

/**
 * Whether setup is required, and whether the deployment serves the files
 * folder (`FDRIVE_STORAGE_ROOT`) setup needs. Powers `/setup`.
 */
export function useSetupStatus() {
  return useQuery({
    queryKey: queryKeys.setup.status(),
    queryFn: () => apiClient.setupStatus(),
  });
}

/**
 * Completes setup: creates the owner's account, logs it in, and
 * seeds the `auth.me` cache so protected feature selection can continue
 * inside the setup screen without entering the application shell.
 */
export function useSetupComplete() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ token, request }: { token: string; request: SetupCompleteRequest }) =>
      apiClient.setupComplete(token, request),
    onSuccess: (me) => {
      queryClient.setQueryData(queryKeys.auth.me(), me);
      void queryClient.invalidateQueries({ queryKey: queryKeys.providers.list() });
    },
  });
}

/** The files folder's storage row (name, reachability, Trash) for System > General. */
export function useAdminProviders() {
  return useQuery({
    queryKey: queryKeys.admin.providers(),
    queryFn: () => apiClient.adminProviders(),
  });
}

function useInvalidatingMutation<TInput, TOutput>(
  section: SystemActivityId,
  background: boolean,
  mutationFn: (input: TInput) => Promise<TOutput>,
  ...keys: readonly (readonly unknown[])[]
) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: {
      systemActivity: [section],
      systemActivityBackground: background,
    },
    mutationFn,
    onSuccess: () => {
      for (const key of keys) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
}

/**
 * Renames the storage and refreshes everywhere the name shows: the admin
 * view, the login page's list and the signed-in account's logins.
 */
export const useAdminUpdateProvider = () =>
  useInvalidatingMutation(
    "general",
    false,
    ({ id, patch }: { id: string; patch: AdminProviderUpdateRequest }) =>
      apiClient.adminUpdateProvider(id, patch),
    queryKeys.admin.providers(),
    queryKeys.providers.list(),
    queryKeys.auth.me(),
  );

/** The files folder's users for System > Users; `available` is false without a folder. */
export function useAdminUsers() {
  return useQuery({
    queryKey: queryKeys.admin.users(),
    queryFn: () => apiClient.adminUsers(),
  });
}

/** Adds a local user and refreshes the list. */
export const useAdminCreateUser = () =>
  useInvalidatingMutation(
    "users",
    false,
    (input: AdminUserCreateRequest) => apiClient.adminCreateUser(input),
    queryKeys.admin.users(),
  );

/** Resets a local user's password, disables or enables them, or changes the administrator flag. */
export const useAdminUpdateUser = () =>
  useInvalidatingMutation(
    "users",
    false,
    ({ username, patch }: { username: string; patch: AdminUserUpdateRequest }) =>
      apiClient.adminUpdateUser(username, patch),
    queryKeys.admin.users(),
  );

/**
 * Removes a local user and their login; their files stay in the folder. The
 * provider list is refreshed too, since its login counts include theirs.
 */
export const useAdminDeleteUser = () =>
  useInvalidatingMutation(
    "users",
    false,
    (username: string) => apiClient.adminDeleteUser(username),
    queryKeys.admin.users(),
    queryKeys.admin.providers(),
  );

/** Indexer health, stats, and settings for `System > Indexer`. Polls every 5s while mounted. */
export function useSystemIndexer() {
  return useQuery({
    queryKey: queryKeys.system.indexer(),
    queryFn: () => apiClient.systemIndexer(),
    refetchInterval: SYSTEM_REFETCH_INTERVAL_MS,
  });
}

/** Saves the indexer's settings and refreshes the `System > Indexer` cache. */
export const useUpdateIndexerSettings = () =>
  useInvalidatingMutation(
    "textSearch",
    false,
    (settings: IndexerSettingsUpdateRequest) => apiClient.systemUpdateIndexerSettings(settings),
    queryKeys.system.indexer(),
  );

/** Marks a root (or one path within it) pending on the indexer. */
export const useReindex = () =>
  useInvalidatingMutation(
    "textSearch",
    true,
    (req: IndexerReindexRequest) => apiClient.systemReindex(req),
    queryKeys.system.indexer(),
  );

/** Starts a background preview rebuild for all roots or one selected scope. */
export function useRebuildIndexerThumbnails() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: { systemActivity: ["thumbnails"], systemActivityBackground: true },
    mutationKey: MAINTENANCE_KEY,
    mutationFn: (req?: IndexerThumbnailsRebuildRequest) =>
      apiClient.systemRebuildIndexerThumbnails(req),
    onSettled: () => {
      // The accepted job can close its dialog while cache-size queries refresh.
      void queryClient.invalidateQueries({ queryKey: queryKeys.system.indexer() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.system.thumbnails() });
    },
  });
}

/** Semantic search status and index totals for `System > Search`. Polls every 5s while mounted. */
export function useSystemSearch() {
  return useQuery({
    queryKey: queryKeys.system.search(),
    queryFn: () => apiClient.systemSearch(),
    refetchInterval: SYSTEM_REFETCH_INTERVAL_MS,
  });
}

/** Triggers a full re-extraction and re-embed of every configured root. */
export const useReembed = () =>
  useInvalidatingMutation(
    "semanticSearch",
    true,
    () => apiClient.systemReembed(),
    queryKeys.system.search(),
    queryKeys.system.indexer(),
  );

/** OCR schedule, last run, and settings for `System > OCR`. Polls every 5s while mounted. */
export function useSystemOcr() {
  return useQuery({
    queryKey: queryKeys.system.ocr(),
    queryFn: () => apiClient.systemOcr(),
    refetchInterval: SYSTEM_REFETCH_INTERVAL_MS,
  });
}

/** Saves the OCR service's settings and refreshes the `System > OCR` cache. */
export const useUpdateOcrSettings = () =>
  useInvalidatingMutation(
    "pdfOcr",
    false,
    (settings: OcrSettingsUpdateRequest) => apiClient.systemUpdateOcrSettings(settings),
    queryKeys.system.ocr(),
  );

/** Runs the OCR pass now. */
export function useRunOcr() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: { systemActivity: ["pdfOcr"], systemActivityBackground: true },
    mutationFn: () => apiClient.systemRunOcr(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.system.ocr() });
    },
  });
}

/** Page size for the kept-originals sheet on `System > OCR`. */
export const OCR_ORIGINALS_PAGE_SIZE = 25;

/**
 * One page of the originals kept before an OCR rewrite. Unlike the rest of the
 * System page this does not poll: the list only changes when the operator acts
 * on it or a pass runs, and each page stats files on the OCR host.
 */
export function useOcrOriginals(query: string, offset: number, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.system.ocrOriginals(query, offset),
    queryFn: () => apiClient.systemOcrOriginals({ query, offset, limit: OCR_ORIGINALS_PAGE_SIZE }),
    enabled,
    placeholderData: keepPreviousData,
  });
}

/**
 * Puts one kept original back over its source path. Invalidates the whole OCR
 * subtree: a restore changes both the listing and the originals tiles.
 */
export function useRestoreOcrOriginal() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (req: OcrOriginalRestoreRequest) => apiClient.systemRestoreOcrOriginal(req),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.system.ocr() });
    },
  });
}

/** Deletes one kept original's bytes. Irreversible. */
export function useDeleteOcrOriginal() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => apiClient.systemDeleteOcrOriginal({ id }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.system.ocr() });
    },
  });
}

/** Thumbnail cache size for `System > Thumbnails`. Polls every 5s while mounted. */
export function useSystemThumbnails() {
  return useQuery({
    queryKey: queryKeys.system.thumbnails(),
    queryFn: () => apiClient.systemThumbnails(),
    refetchInterval: SYSTEM_REFETCH_INTERVAL_MS,
  });
}

/** Rebuilds every missing thumbnail. */
export function useRebuildThumbnails() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: { systemActivity: ["thumbnails"], systemActivityBackground: true },
    mutationFn: () => apiClient.systemRebuildThumbnails(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.system.thumbnails() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.system.indexer() });
    },
  });
}

/** Pending mutations stay shared when navigating between maintenance pages. */
export function useSystemMaintenanceBusy(stats: IndexerStats | undefined) {
  const pending = useIsMutating({ mutationKey: MAINTENANCE_KEY });
  return (
    pending > 0 ||
    stats?.indexClear?.running === true ||
    stats?.thumbnailClear?.running === true ||
    stats?.thumbnailRebuild?.running === true
  );
}

/** Clears scoped index data and refreshes counts even after a busy response. */
export function useClearIndex() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { systemActivity: ["textSearch", "semanticSearch"], systemActivityBackground: true },
    mutationKey: MAINTENANCE_KEY,
    mutationFn: (request: IndexerClearRequest) => apiClient.systemClearIndex(request),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.system.indexer() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.system.search() }),
      ]),
  });
}

/** Clears the shared preview cache and refreshes progress and cache totals. */
export function useClearThumbnails() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { systemActivity: ["thumbnails"], systemActivityBackground: true },
    mutationKey: MAINTENANCE_KEY,
    mutationFn: () => apiClient.systemClearThumbnails(),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.system.indexer() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.system.thumbnails() }),
      ]),
  });
}

/** Image-embedding sidecar status and embedded count for `System > Image search`. Polls every 5s while mounted. */
export function useSystemImageSearch() {
  return useQuery({
    queryKey: queryKeys.system.imageSearch(),
    queryFn: () => apiClient.systemImageSearch(),
    refetchInterval: SYSTEM_REFETCH_INTERVAL_MS,
  });
}

/** Starts a background image-embedding rebuild, optionally replacing rows from another model. */
export function useRebuildImageSearch() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: { systemActivity: ["imageSearch"], systemActivityBackground: true },
    mutationKey: MAINTENANCE_KEY,
    mutationFn: (req?: IndexerThumbnailsRebuildRequest) => apiClient.systemImageSearchRebuild(req),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.system.imageSearch() }),
  });
}

/** Clears every stored image embedding. */
export function useClearImageSearch() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: { systemActivity: ["imageSearch"], systemActivityBackground: true },
    mutationKey: MAINTENANCE_KEY,
    mutationFn: () => apiClient.systemImageSearchClear(),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.system.imageSearch() }),
  });
}
