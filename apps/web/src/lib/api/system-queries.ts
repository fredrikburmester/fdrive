"use client";

import type {
  AdminProviderCreateRequest,
  AdminProviderTestRequest,
  AdminProviderUpdateRequest,
  FeaturesUpdateRequest,
  IndexerClearRequest,
  IndexerReindexRequest,
  IndexerSettingsUpdateRequest,
  IndexerStats,
  IndexerThumbnailsRebuildRequest,
  OcrSettingsUpdateRequest,
  SetupCompleteRequest,
  SystemActivityId,
} from "@fdrive/contracts";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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

/** Whether setup is required and whether `SFTPGO_URL` is set by environment. Powers `/setup`. */
export function useSetupStatus() {
  return useQuery({
    queryKey: queryKeys.setup.status(),
    queryFn: () => apiClient.setupStatus(),
  });
}

/** Probes a candidate SFTPGo base URL during setup, using the one-time setup token. */
export function useSetupTest() {
  return useMutation({
    mutationFn: ({ token, baseUrl }: { token: string; baseUrl: string }) =>
      apiClient.setupTest(token, baseUrl),
  });
}

/**
 * Completes setup: stores the connection, logs the admin account in, and
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

/** Every configured storage provider plus the types an admin can add, for System > Storage. */
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

/** Adds a provider (the API stores it without probing) and refreshes the cached list. */
export const useAdminCreateProvider = () =>
  useInvalidatingMutation(
    "storage",
    false,
    (input: AdminProviderCreateRequest) => apiClient.adminCreateProvider(input),
    queryKeys.admin.providers(),
    queryKeys.providers.list(),
  );

/** Updates one provider (label, address, configuration, enabled) and refreshes the cached list. */
export const useAdminUpdateProvider = () =>
  useInvalidatingMutation(
    "storage",
    false,
    ({ id, patch }: { id: string; patch: AdminProviderUpdateRequest }) =>
      apiClient.adminUpdateProvider(id, patch),
    queryKeys.admin.providers(),
    queryKeys.providers.list(),
    queryKeys.auth.me(),
  );

/** Removes a provider and refreshes the cached list. Refused while logins still use it. */
export const useAdminDeleteProvider = () =>
  useInvalidatingMutation(
    "storage",
    false,
    (id: string) => apiClient.adminDeleteProvider(id),
    queryKeys.admin.providers(),
    queryKeys.providers.list(),
  );

/** Probes a saved provider (by id) or an unsaved candidate, without saving anything. */
export function useAdminTestProvider() {
  return useMutation({
    meta: { systemActivity: ["storage"], systemActivityBackground: false },
    mutationFn: (target: string | AdminProviderTestRequest) => apiClient.adminTestProvider(target),
  });
}

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
