// @vitest-environment jsdom

import type { AdminProvidersResponse, IndexerStats, MeResponse } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeIdentity, makeMe } from "@/test-fixtures/identity";

const setupStatusMock = vi.fn();
const systemFeaturesMock = vi.fn();
const systemUpdateFeaturesMock = vi.fn();
const setupTestMock = vi.fn();
const setupCompleteMock = vi.fn();
const adminProvidersMock = vi.fn();
const adminCreateProviderMock = vi.fn();
const adminUpdateProviderMock = vi.fn();
const adminDeleteProviderMock = vi.fn();
const adminTestProviderMock = vi.fn();
const systemIndexerMock = vi.fn();
const systemUpdateIndexerSettingsMock = vi.fn();
const systemReindexMock = vi.fn();
const systemRebuildIndexerThumbnailsMock = vi.fn();
const systemSearchMock = vi.fn();
const systemReembedMock = vi.fn();
const systemOcrMock = vi.fn();
const systemUpdateOcrSettingsMock = vi.fn();
const systemRunOcrMock = vi.fn();
const systemThumbnailsMock = vi.fn();
const systemRebuildThumbnailsMock = vi.fn();
const systemClearIndexMock = vi.fn();
const systemClearThumbnailsMock = vi.fn();
const systemImageSearchMock = vi.fn();
const systemImageSearchRebuildMock = vi.fn();
const systemImageSearchClearMock = vi.fn();

vi.mock("./client.js", () => ({
  apiClient: {
    systemFeatures: (...args: unknown[]) => systemFeaturesMock(...args),
    systemUpdateFeatures: (...args: unknown[]) => systemUpdateFeaturesMock(...args),
    setupStatus: (...args: unknown[]) => setupStatusMock(...args),
    setupTest: (...args: unknown[]) => setupTestMock(...args),
    setupComplete: (...args: unknown[]) => setupCompleteMock(...args),
    adminProviders: (...args: unknown[]) => adminProvidersMock(...args),
    adminCreateProvider: (...args: unknown[]) => adminCreateProviderMock(...args),
    adminUpdateProvider: (...args: unknown[]) => adminUpdateProviderMock(...args),
    adminDeleteProvider: (...args: unknown[]) => adminDeleteProviderMock(...args),
    adminTestProvider: (...args: unknown[]) => adminTestProviderMock(...args),
    systemIndexer: (...args: unknown[]) => systemIndexerMock(...args),
    systemUpdateIndexerSettings: (...args: unknown[]) => systemUpdateIndexerSettingsMock(...args),
    systemReindex: (...args: unknown[]) => systemReindexMock(...args),
    systemRebuildIndexerThumbnails: (...args: unknown[]) =>
      systemRebuildIndexerThumbnailsMock(...args),
    systemSearch: (...args: unknown[]) => systemSearchMock(...args),
    systemReembed: (...args: unknown[]) => systemReembedMock(...args),
    systemOcr: (...args: unknown[]) => systemOcrMock(...args),
    systemUpdateOcrSettings: (...args: unknown[]) => systemUpdateOcrSettingsMock(...args),
    systemRunOcr: (...args: unknown[]) => systemRunOcrMock(...args),
    systemThumbnails: (...args: unknown[]) => systemThumbnailsMock(...args),
    systemClearIndex: (...args: unknown[]) => systemClearIndexMock(...args),
    systemClearThumbnails: (...args: unknown[]) => systemClearThumbnailsMock(...args),
    systemRebuildThumbnails: (...args: unknown[]) => systemRebuildThumbnailsMock(...args),
    systemImageSearch: (...args: unknown[]) => systemImageSearchMock(...args),
    systemImageSearchRebuild: (...args: unknown[]) => systemImageSearchRebuildMock(...args),
    systemImageSearchClear: (...args: unknown[]) => systemImageSearchClearMock(...args),
  },
}));

const ME_RESPONSE = makeMe({
  account: { id: "00000000-0000-0000-0000-000000000000", displayName: "Ada" },
  identities: [
    makeIdentity({ id: "00000000-0000-0000-0000-000000000001", providerLabel: "SFTPGo" }),
  ],
  activeIdentityId: "00000000-0000-0000-0000-000000000001",
  isAdmin: true,
});

describe("feature queries", () => {
  it("fetches choices and updates caches after saving a revision", async () => {
    const values = {
      thumbnails: false,
      textSearch: false,
      searchOcr: false,
      semanticSearch: false,
      imageSearch: false,
      pdfOcr: false,
    };
    const data = {
      configuration: { version: 1, revision: 0, values, walkthroughComplete: false },
      source: "default",
      statuses: [],
      roots: [],
    };
    const saved = { ...data, configuration: { ...data.configuration, revision: 1 } };
    systemFeaturesMock.mockResolvedValue(data);
    systemUpdateFeaturesMock.mockResolvedValue(saved);
    const client = new QueryClient();
    const { useSystemFeatures, useUpdateFeatures } = await import("./system-queries.js");
    const wrapper = createWrapper(client);
    const query = renderHook(() => useSystemFeatures(), { wrapper });
    await waitFor(() => expect(query.result.current.data).toEqual(data));
    const mutation = renderHook(() => useUpdateFeatures(), { wrapper });
    await mutation.result.current.mutateAsync({ revision: 0, values, walkthroughComplete: false });
    expect(systemUpdateFeaturesMock).toHaveBeenCalledWith({
      revision: 0,
      values,
      walkthroughComplete: false,
    });
    expect(systemFeaturesMock).toHaveBeenCalled();
  });
});

const PROVIDER = {
  id: "00000000-0000-4000-8000-000000000009",
  type: "sftpgo" as const,
  label: "sftpgo:8080",
  baseUrl: "http://sftpgo:8080",
  config: { homeTemplate: "sftpgo:/{username}" },
  enabled: true,
  managedByEnv: true,
  identityCount: 1,
  reachable: true,
  checkedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
};
const PROVIDERS_RESPONSE: AdminProvidersResponse = { providers: [PROVIDER], types: [] };

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

beforeEach(() => {
  setupStatusMock.mockReset();
  setupTestMock.mockReset();
  setupCompleteMock.mockReset();
  adminProvidersMock.mockReset();
  adminCreateProviderMock.mockReset();
  adminUpdateProviderMock.mockReset();
  adminDeleteProviderMock.mockReset();
  adminTestProviderMock.mockReset();
  systemIndexerMock.mockReset();
  systemUpdateIndexerSettingsMock.mockReset();
  systemReindexMock.mockReset();
  systemRebuildIndexerThumbnailsMock.mockReset();
  systemSearchMock.mockReset();
  systemReembedMock.mockReset();
  systemOcrMock.mockReset();
  systemUpdateOcrSettingsMock.mockReset();
  systemRunOcrMock.mockReset();
  systemThumbnailsMock.mockReset();
  systemRebuildThumbnailsMock.mockReset();
  systemClearIndexMock.mockReset();
  systemClearThumbnailsMock.mockReset();
  systemImageSearchMock.mockReset();
  systemImageSearchRebuildMock.mockReset();
  systemImageSearchClearMock.mockReset();
});

describe("useSetupStatus", () => {
  it("fetches the setup status", async () => {
    setupStatusMock.mockResolvedValue({ required: true, hasEnvUrl: false });
    const { useSetupStatus } = await import("./system-queries.js");
    const queryClient = new QueryClient();

    const { result } = renderHook(() => useSetupStatus(), { wrapper: createWrapper(queryClient) });

    await waitFor(() => expect(result.current.data).toEqual({ required: true, hasEnvUrl: false }));
  });
});

describe("useSetupTest", () => {
  it("probes a candidate connection with the setup token", async () => {
    setupTestMock.mockResolvedValue({ ok: true, detail: "reachable" });
    const { useSetupTest } = await import("./system-queries.js");
    const queryClient = new QueryClient();

    const { result } = renderHook(() => useSetupTest(), { wrapper: createWrapper(queryClient) });
    result.current.mutate({ token: "tok-1", baseUrl: "http://sftpgo:8080" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(setupTestMock).toHaveBeenCalledWith("tok-1", "http://sftpgo:8080");
  });
});

describe("useSetupComplete", () => {
  it("completes setup and seeds the auth.me cache", async () => {
    setupCompleteMock.mockResolvedValue(ME_RESPONSE);
    const { useSetupComplete } = await import("./system-queries.js");
    const queryClient = new QueryClient();

    const { result } = renderHook(() => useSetupComplete(), {
      wrapper: createWrapper(queryClient),
    });
    result.current.mutate({
      token: "tok-1",
      request: {
        baseUrl: "http://sftpgo:8080",
        homeTemplate: "sftpgo:/{username}",
        username: "ada",
        password: "hunter2",
      },
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData(["auth", "me"])).toEqual(ME_RESPONSE);
  });
});

describe("useAdminProviders", () => {
  it("fetches the configured providers", async () => {
    adminProvidersMock.mockResolvedValue(PROVIDERS_RESPONSE);
    const { useAdminProviders } = await import("./system-queries.js");
    const queryClient = new QueryClient();

    const { result } = renderHook(() => useAdminProviders(), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.data).toEqual(PROVIDERS_RESPONSE));
  });
});

describe("useAdminCreateProvider", () => {
  it("adds a provider and invalidates the cached list", async () => {
    adminCreateProviderMock.mockResolvedValue(PROVIDER);
    adminProvidersMock.mockResolvedValue(PROVIDERS_RESPONSE);
    const { useAdminCreateProvider } = await import("./system-queries.js");
    const queryClient = new QueryClient();
    queryClient.setQueryData(["admin", "providers"], PROVIDERS_RESPONSE);

    const { result } = renderHook(() => useAdminCreateProvider(), {
      wrapper: createWrapper(queryClient),
    });
    result.current.mutate({ type: "sftpgo", label: "Second", baseUrl: "http://other:8080" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(adminCreateProviderMock).toHaveBeenCalledWith({
      type: "sftpgo",
      label: "Second",
      baseUrl: "http://other:8080",
    });
    expect(queryClient.getQueryState(["admin", "providers"])?.isInvalidated).toBe(true);
  });
});

describe("useAdminDeleteProvider", () => {
  it("removes a provider and invalidates the cached list", async () => {
    adminDeleteProviderMock.mockResolvedValue({ ok: true });
    adminProvidersMock.mockResolvedValue({ providers: [], types: [] });
    const { useAdminDeleteProvider } = await import("./system-queries.js");
    const queryClient = new QueryClient();
    queryClient.setQueryData(["admin", "providers"], PROVIDERS_RESPONSE);

    const { result } = renderHook(() => useAdminDeleteProvider(), {
      wrapper: createWrapper(queryClient),
    });
    result.current.mutate(PROVIDER.id);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(adminDeleteProviderMock).toHaveBeenCalledWith(PROVIDER.id);
    expect(queryClient.getQueryState(["admin", "providers"])?.isInvalidated).toBe(true);
  });
});

describe("useAdminUpdateProvider", () => {
  it("updates a provider and invalidates the cached list", async () => {
    const updated = { ...PROVIDER, config: { homeTemplate: "sftpgo:/new/{username}" } };
    adminUpdateProviderMock.mockResolvedValue(updated);
    adminProvidersMock.mockResolvedValue({ providers: [updated], types: [] });
    const { useAdminUpdateProvider } = await import("./system-queries.js");
    const queryClient = new QueryClient();
    queryClient.setQueryData(["admin", "providers"], PROVIDERS_RESPONSE);

    const { result } = renderHook(() => useAdminUpdateProvider(), {
      wrapper: createWrapper(queryClient),
    });
    result.current.mutate({
      id: PROVIDER.id,
      patch: { config: { homeTemplate: "sftpgo:/new/{username}" } },
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(adminUpdateProviderMock).toHaveBeenCalledWith(PROVIDER.id, {
      config: { homeTemplate: "sftpgo:/new/{username}" },
    });
    expect(queryClient.getQueryState(["admin", "providers"])?.isInvalidated).toBe(true);
  });
});

describe("useAdminTestProvider", () => {
  it("probes a saved provider by id", async () => {
    adminTestProviderMock.mockResolvedValue({ ok: true, detail: "reachable" });
    const { useAdminTestProvider } = await import("./system-queries.js");
    const queryClient = new QueryClient();

    const { result } = renderHook(() => useAdminTestProvider(), {
      wrapper: createWrapper(queryClient),
    });
    result.current.mutate(PROVIDER.id);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(adminTestProviderMock).toHaveBeenCalledWith(PROVIDER.id);
  });

  it("probes an unsaved candidate", async () => {
    adminTestProviderMock.mockResolvedValue({ ok: false, detail: "unreachable" });
    const { useAdminTestProvider } = await import("./system-queries.js");
    const queryClient = new QueryClient();

    const { result } = renderHook(() => useAdminTestProvider(), {
      wrapper: createWrapper(queryClient),
    });
    result.current.mutate({ type: "sftpgo", baseUrl: "http://other:8080" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(adminTestProviderMock).toHaveBeenCalledWith({
      type: "sftpgo",
      baseUrl: "http://other:8080",
    });
  });
});

const INDEXER_SETTINGS = {
  values: {
    scanIntervalSeconds: 900,
    workers: 4,
    textExcludeGlobs: [],
    ocrImageGlobs: [],
    tesseractLangs: "swe+eng",
  },
  sources: {
    scanIntervalSeconds: "default",
    workers: "default",
    textExcludeGlobs: "default",
    ocrImageGlobs: "default",
    tesseractLangs: "default",
  },
} as const;

const SYSTEM_INDEXER_RESPONSE = {
  configured: false,
  reachable: false,
  settings: INDEXER_SETTINGS,
} as const;

describe("useSystemIndexer", () => {
  it("fetches the indexer status", async () => {
    systemIndexerMock.mockResolvedValue(SYSTEM_INDEXER_RESPONSE);
    const { useSystemIndexer } = await import("./system-queries.js");
    const queryClient = new QueryClient();

    const { result } = renderHook(() => useSystemIndexer(), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.data).toEqual(SYSTEM_INDEXER_RESPONSE));
  });
});

describe("useUpdateIndexerSettings", () => {
  it("saves the settings and invalidates the indexer query", async () => {
    systemIndexerMock.mockResolvedValue(SYSTEM_INDEXER_RESPONSE);
    systemUpdateIndexerSettingsMock.mockResolvedValue(INDEXER_SETTINGS);
    const { useSystemIndexer, useUpdateIndexerSettings } = await import("./system-queries.js");
    const queryClient = new QueryClient();
    const wrapper = createWrapper(queryClient);

    const { result: query } = renderHook(() => useSystemIndexer(), { wrapper });
    await waitFor(() => expect(query.current.isSuccess).toBe(true));

    const { result: mutation } = renderHook(() => useUpdateIndexerSettings(), { wrapper });
    mutation.current.mutate({
      ...INDEXER_SETTINGS.values,
      textExcludeGlobs: [],
      ocrImageGlobs: [],
    });

    await waitFor(() => expect(mutation.current.isSuccess).toBe(true));
    expect(systemUpdateIndexerSettingsMock).toHaveBeenCalledWith(INDEXER_SETTINGS.values);
    expect(systemIndexerMock).toHaveBeenCalledTimes(2);
  });
});

describe("useReindex", () => {
  it("posts the reindex request and invalidates the indexer query", async () => {
    systemIndexerMock.mockResolvedValue(SYSTEM_INDEXER_RESPONSE);
    systemReindexMock.mockResolvedValue({ marked: 3 });
    const { useSystemIndexer, useReindex } = await import("./system-queries.js");
    const queryClient = new QueryClient();
    const wrapper = createWrapper(queryClient);

    const { result: query } = renderHook(() => useSystemIndexer(), { wrapper });
    await waitFor(() => expect(query.current.isSuccess).toBe(true));

    const { result: mutation } = renderHook(() => useReindex(), { wrapper });
    mutation.current.mutate({ root: "sftpgo" });

    await waitFor(() => expect(mutation.current.data).toEqual({ marked: 3 }));
    expect(systemIndexerMock).toHaveBeenCalledTimes(2);
  });
});

describe("useRebuildIndexerThumbnails", () => {
  it("posts the rebuild request and invalidates the indexer query", async () => {
    systemIndexerMock.mockResolvedValue(SYSTEM_INDEXER_RESPONSE);
    systemRebuildIndexerThumbnailsMock.mockResolvedValue({ marked: 10 });
    const { useSystemIndexer, useRebuildIndexerThumbnails } = await import("./system-queries.js");
    const queryClient = new QueryClient();
    const wrapper = createWrapper(queryClient);

    const { result: query } = renderHook(() => useSystemIndexer(), { wrapper });
    await waitFor(() => expect(query.current.isSuccess).toBe(true));

    const { result: mutation } = renderHook(() => useRebuildIndexerThumbnails(), { wrapper });
    mutation.current.mutate(undefined);

    await waitFor(() => expect(mutation.current.data).toEqual({ marked: 10 }));
    expect(systemIndexerMock).toHaveBeenCalledTimes(2);
  });
});

const SYSTEM_SEARCH_RESPONSE = {
  configured: false,
  semantic: { configured: false, healthy: false },
  roots: [],
  index: { files: 0, withText: 0, chunks: 0, embedded: 0 },
} as const;

describe("useSystemSearch", () => {
  it("fetches the search status", async () => {
    systemSearchMock.mockResolvedValue(SYSTEM_SEARCH_RESPONSE);
    const { useSystemSearch } = await import("./system-queries.js");
    const queryClient = new QueryClient();

    const { result } = renderHook(() => useSystemSearch(), { wrapper: createWrapper(queryClient) });

    await waitFor(() => expect(result.current.data).toEqual(SYSTEM_SEARCH_RESPONSE));
  });
});

describe("useReembed", () => {
  it("triggers a re-embed and invalidates search and indexer queries", async () => {
    systemSearchMock.mockResolvedValue(SYSTEM_SEARCH_RESPONSE);
    systemIndexerMock.mockResolvedValue(SYSTEM_INDEXER_RESPONSE);
    systemReembedMock.mockResolvedValue({ marked: 5, roots: ["sftpgo"] });
    const { useSystemSearch, useSystemIndexer, useReembed } = await import("./system-queries.js");
    const queryClient = new QueryClient();
    const wrapper = createWrapper(queryClient);

    const { result: searchQuery } = renderHook(() => useSystemSearch(), { wrapper });
    const { result: indexerQuery } = renderHook(() => useSystemIndexer(), { wrapper });
    await waitFor(() => expect(searchQuery.current.isSuccess).toBe(true));
    await waitFor(() => expect(indexerQuery.current.isSuccess).toBe(true));

    const { result: mutation } = renderHook(() => useReembed(), { wrapper });
    mutation.current.mutate();

    await waitFor(() => expect(mutation.current.isSuccess).toBe(true));
    expect(systemSearchMock).toHaveBeenCalledTimes(2);
    expect(systemIndexerMock).toHaveBeenCalledTimes(2);
  });
});

const OCR_SETTINGS = {
  values: { hour: 3, langs: "swe+eng", excludeGlobs: [], maxMb: 200, keepOriginals: false },
  sources: {
    hour: "default",
    langs: "default",
    excludeGlobs: "default",
    maxMb: "default",
    keepOriginals: "default",
  },
} as const;

const SYSTEM_OCR_RESPONSE = {
  configured: false,
  reachable: false,
  settings: OCR_SETTINGS,
} as const;

describe("useSystemOcr", () => {
  it("fetches the OCR status", async () => {
    systemOcrMock.mockResolvedValue(SYSTEM_OCR_RESPONSE);
    const { useSystemOcr } = await import("./system-queries.js");
    const queryClient = new QueryClient();

    const { result } = renderHook(() => useSystemOcr(), { wrapper: createWrapper(queryClient) });

    await waitFor(() => expect(result.current.data).toEqual(SYSTEM_OCR_RESPONSE));
  });
});

describe("useUpdateOcrSettings", () => {
  it("saves the settings and invalidates the OCR query", async () => {
    systemOcrMock.mockResolvedValue(SYSTEM_OCR_RESPONSE);
    systemUpdateOcrSettingsMock.mockResolvedValue(OCR_SETTINGS);
    const { useSystemOcr, useUpdateOcrSettings } = await import("./system-queries.js");
    const queryClient = new QueryClient();
    const wrapper = createWrapper(queryClient);

    const { result: query } = renderHook(() => useSystemOcr(), { wrapper });
    await waitFor(() => expect(query.current.isSuccess).toBe(true));

    const { result: mutation } = renderHook(() => useUpdateOcrSettings(), { wrapper });
    mutation.current.mutate({ ...OCR_SETTINGS.values, excludeGlobs: [] });

    await waitFor(() => expect(mutation.current.isSuccess).toBe(true));
    expect(systemOcrMock).toHaveBeenCalledTimes(2);
  });
});

describe("useRunOcr", () => {
  it("runs OCR and invalidates the OCR query", async () => {
    systemOcrMock.mockResolvedValue(SYSTEM_OCR_RESPONSE);
    systemRunOcrMock.mockResolvedValue({ started: true });
    const { useSystemOcr, useRunOcr } = await import("./system-queries.js");
    const queryClient = new QueryClient();
    const wrapper = createWrapper(queryClient);

    const { result: query } = renderHook(() => useSystemOcr(), { wrapper });
    await waitFor(() => expect(query.current.isSuccess).toBe(true));

    const { result: mutation } = renderHook(() => useRunOcr(), { wrapper });
    mutation.current.mutate();

    await waitFor(() => expect(mutation.current.data).toEqual({ started: true }));
    expect(systemOcrMock).toHaveBeenCalledTimes(2);
  });
});

const SYSTEM_THUMBNAILS_RESPONSE = { configured: false, count: 0, bytes: 0 } as const;

describe("useSystemThumbnails", () => {
  it("fetches the thumbnails status", async () => {
    systemThumbnailsMock.mockResolvedValue(SYSTEM_THUMBNAILS_RESPONSE);
    const { useSystemThumbnails } = await import("./system-queries.js");
    const queryClient = new QueryClient();

    const { result } = renderHook(() => useSystemThumbnails(), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.data).toEqual(SYSTEM_THUMBNAILS_RESPONSE));
  });
});

describe("useRebuildThumbnails", () => {
  it("rebuilds thumbnails and invalidates the thumbnails and indexer queries", async () => {
    systemThumbnailsMock.mockResolvedValue(SYSTEM_THUMBNAILS_RESPONSE);
    systemIndexerMock.mockResolvedValue(SYSTEM_INDEXER_RESPONSE);
    systemRebuildThumbnailsMock.mockResolvedValue({ marked: 20 });
    const { useSystemThumbnails, useSystemIndexer, useRebuildThumbnails } = await import(
      "./system-queries.js"
    );
    const queryClient = new QueryClient();
    const wrapper = createWrapper(queryClient);

    const { result: thumbsQuery } = renderHook(() => useSystemThumbnails(), { wrapper });
    const { result: indexerQuery } = renderHook(() => useSystemIndexer(), { wrapper });
    await waitFor(() => expect(thumbsQuery.current.isSuccess).toBe(true));
    await waitFor(() => expect(indexerQuery.current.isSuccess).toBe(true));

    const { result: mutation } = renderHook(() => useRebuildThumbnails(), { wrapper });
    mutation.current.mutate();

    await waitFor(() => expect(mutation.current.data).toEqual({ marked: 20 }));
    expect(systemThumbnailsMock).toHaveBeenCalledTimes(2);
    expect(systemIndexerMock).toHaveBeenCalledTimes(2);
  });
});

describe("maintenance mutations", () => {
  it.each([false, true])(
    "clears index scope and refreshes counts after failure=%s",
    async (fail) => {
      systemIndexerMock.mockResolvedValue(SYSTEM_INDEXER_RESPONSE);
      systemSearchMock.mockResolvedValue(SYSTEM_SEARCH_RESPONSE);
      if (fail) systemClearIndexMock.mockRejectedValue(new Error("busy"));
      else systemClearIndexMock.mockResolvedValue({ started: true });
      const { useSystemIndexer, useSystemSearch, useClearIndex } = await import(
        "./system-queries.js"
      );
      const wrapper = createWrapper(new QueryClient());
      const indexer = renderHook(() => useSystemIndexer(), { wrapper });
      const search = renderHook(() => useSystemSearch(), { wrapper });
      await waitFor(() =>
        expect(indexer.result.current.isSuccess && search.result.current.isSuccess).toBe(true),
      );
      const mutation = renderHook(() => useClearIndex(), { wrapper });
      mutation.result.current.mutate({ root: "sftpgo", path: "alice/docs" });
      await waitFor(() =>
        expect(fail ? mutation.result.current.isError : mutation.result.current.isSuccess).toBe(
          true,
        ),
      );
      expect(systemClearIndexMock).toHaveBeenCalledWith({ root: "sftpgo", path: "alice/docs" });
      expect(systemIndexerMock).toHaveBeenCalledTimes(2);
      expect(systemSearchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("clears thumbnails and refreshes cache and job progress", async () => {
    systemIndexerMock.mockResolvedValue(SYSTEM_INDEXER_RESPONSE);
    systemThumbnailsMock.mockResolvedValue(SYSTEM_THUMBNAILS_RESPONSE);
    systemClearThumbnailsMock.mockResolvedValue({ started: true });
    const { useSystemIndexer, useSystemThumbnails, useClearThumbnails } = await import(
      "./system-queries.js"
    );
    const wrapper = createWrapper(new QueryClient());
    const indexer = renderHook(() => useSystemIndexer(), { wrapper });
    const thumbnails = renderHook(() => useSystemThumbnails(), { wrapper });
    await waitFor(() =>
      expect(indexer.result.current.isSuccess && thumbnails.result.current.isSuccess).toBe(true),
    );
    const mutation = renderHook(() => useClearThumbnails(), { wrapper });
    mutation.result.current.mutate();
    await waitFor(() => expect(mutation.result.current.isSuccess).toBe(true));
    expect(systemClearThumbnailsMock).toHaveBeenCalledWith();
    expect(systemIndexerMock).toHaveBeenCalledTimes(2);
    expect(systemThumbnailsMock).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, "indexClear", "thumbnailClear", "thumbnailRebuild"] as const)(
    "recognizes running job %s",
    async (key) => {
      const { useSystemMaintenanceBusy } = await import("./system-queries.js");
      const stats: IndexerStats | undefined =
        key === undefined
          ? undefined
          : {
              roots: [],
              thumbnails: 0,
              queueDepth: 0,
              errorsSample: [],
              [key]: {
                running: true,
                processed: 0,
                total: 0,
                startedAt: null,
                finishedAt: null,
                errors: 0,
              },
            };
      const { result } = renderHook(() => useSystemMaintenanceBusy(stats), {
        wrapper: createWrapper(new QueryClient()),
      });
      expect(result.current).toBe(key !== undefined);
    },
  );

  describe("useSystemImageSearch", () => {
    it("fetches the image search status", async () => {
      const response = {
        configured: true,
        healthy: true,
        model: "siglip2-base",
        dim: 1024,
        embedded: 5,
        embeddedModel: "siglip2-base",
      };
      systemImageSearchMock.mockResolvedValue(response);
      const { useSystemImageSearch } = await import("./system-queries.js");
      const { result } = renderHook(() => useSystemImageSearch(), {
        wrapper: createWrapper(new QueryClient()),
      });
      await waitFor(() => expect(result.current.data).toEqual(response));
    });
  });

  describe("useRebuildImageSearch", () => {
    it("rebuilds image embeddings and invalidates the image search query", async () => {
      systemImageSearchMock.mockResolvedValue({
        configured: true,
        healthy: true,
        embedded: 0,
        embeddedModel: null,
      });
      systemImageSearchRebuildMock.mockResolvedValue({ started: true, total: 3 });
      const { useSystemImageSearch, useRebuildImageSearch } = await import("./system-queries.js");
      const wrapper = createWrapper(new QueryClient());

      const { result: query } = renderHook(() => useSystemImageSearch(), { wrapper });
      await waitFor(() => expect(query.current.isSuccess).toBe(true));

      const { result: mutation } = renderHook(() => useRebuildImageSearch(), { wrapper });
      mutation.current.mutate({ force: true });

      await waitFor(() => expect(mutation.current.data).toEqual({ started: true, total: 3 }));
      expect(systemImageSearchRebuildMock).toHaveBeenCalledWith({ force: true });
      expect(systemImageSearchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("useClearImageSearch", () => {
    it("clears image embeddings and invalidates the image search query", async () => {
      systemImageSearchMock.mockResolvedValue({
        configured: true,
        healthy: true,
        embedded: 0,
        embeddedModel: null,
      });
      systemImageSearchClearMock.mockResolvedValue({ started: true });
      const { useSystemImageSearch, useClearImageSearch } = await import("./system-queries.js");
      const wrapper = createWrapper(new QueryClient());

      const { result: query } = renderHook(() => useSystemImageSearch(), { wrapper });
      await waitFor(() => expect(query.current.isSuccess).toBe(true));

      const { result: mutation } = renderHook(() => useClearImageSearch(), { wrapper });
      mutation.current.mutate();

      await waitFor(() => expect(mutation.current.isSuccess).toBe(true));
      expect(systemImageSearchClearMock).toHaveBeenCalledWith();
      expect(systemImageSearchMock).toHaveBeenCalledTimes(2);
    });
  });

  it("shares pending state across mounted maintenance consumers", async () => {
    let finish: ((value: { started: boolean }) => void) | undefined;
    systemClearThumbnailsMock.mockImplementation(
      () =>
        new Promise<{ started: boolean }>((resolve) => {
          finish = resolve;
        }),
    );
    const { useClearThumbnails, useSystemMaintenanceBusy } = await import("./system-queries.js");
    const wrapper = createWrapper(new QueryClient());
    const mutation = renderHook(() => useClearThumbnails(), { wrapper });
    const busy = renderHook(() => useSystemMaintenanceBusy(undefined), { wrapper });
    expect(busy.result.current).toBe(false);
    mutation.result.current.mutate();
    await waitFor(() => expect(busy.result.current).toBe(true));
    finish?.({ started: true });
    await waitFor(() => expect(busy.result.current).toBe(false));
  });
});
