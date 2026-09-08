"use client";

import type {
  AdminConnectionUpdateRequest,
  FeaturesUpdateRequest,
  IndexerClearRequest,
  IndexerReindexRequest,
  IndexerSettingsUpdateRequest,
  IndexerStats,
  IndexerThumbnailsRebuildRequest,
  OcrSettingsUpdateRequest,
  SetupCompleteRequest,
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
 * seeds the `auth.me` cache with the result so the redirect to `/files`
 * lands in an already-authenticated shell.
 */
export function useSetupComplete() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ token, request }: { token: string; request: SetupCompleteRequest }) =>
      apiClient.setupComplete(token, request),
    onSuccess: (me) => {
      queryClient.setQueryData(queryKeys.auth.me(), me);
    },
  });
}

/** The active SFTPGo connection, for the admin System > Connection page. */
export function useAdminConnection() {
  return useQuery({
    queryKey: queryKeys.admin.connection(),
    queryFn: () => apiClient.adminConnection(),
  });
}

/** Updates the connection (base URL and/or home template) and refreshes the cached summary. */
export function useAdminUpdateConnection() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (patch: AdminConnectionUpdateRequest) => apiClient.adminUpdateConnection(patch),
    onSuccess: (connection) => {
      queryClient.setQueryData(queryKeys.admin.connection(), connection);
    },
  });
}

/** Probes the active connection, or a candidate `baseUrl` when given, without saving anything. */
export function useAdminTestConnection() {
  return useMutation({
    mutationFn: (baseUrl?: string) => apiClient.adminTestConnection(baseUrl),
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
export function useUpdateIndexerSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (settings: IndexerSettingsUpdateRequest) =>
      apiClient.systemUpdateIndexerSettings(settings),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.system.indexer() });
    },
  });
}

/** Marks a root (or one path within it) pending on the indexer. */
export function useReindex() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (req: IndexerReindexRequest) => apiClient.systemReindex(req),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.system.indexer() });
    },
  });
}

/** Starts a background preview rebuild for all roots or one selected scope. */
export function useRebuildIndexerThumbnails() {
  const queryClient = useQueryClient();

  return useMutation({
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
export function useReembed() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => apiClient.systemReembed(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.system.search() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.system.indexer() });
    },
  });
}

/** OCR schedule, last run, and settings for `System > OCR`. Polls every 5s while mounted. */
export function useSystemOcr() {
  return useQuery({
    queryKey: queryKeys.system.ocr(),
    queryFn: () => apiClient.systemOcr(),
    refetchInterval: SYSTEM_REFETCH_INTERVAL_MS,
  });
}

/** Saves the OCR service's settings and refreshes the `System > OCR` cache. */
export function useUpdateOcrSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (settings: OcrSettingsUpdateRequest) => apiClient.systemUpdateOcrSettings(settings),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.system.ocr() });
    },
  });
}

/** Runs the OCR pass now. */
export function useRunOcr() {
  const queryClient = useQueryClient();

  return useMutation({
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
    mutationKey: MAINTENANCE_KEY,
    mutationFn: (req?: IndexerThumbnailsRebuildRequest) => apiClient.systemImageSearchRebuild(req),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.system.imageSearch() }),
  });
}

/** Clears every stored image embedding. */
export function useClearImageSearch() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: MAINTENANCE_KEY,
    mutationFn: () => apiClient.systemImageSearchClear(),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.system.imageSearch() }),
  });
}
