// @vitest-environment jsdom
import type { AdminConnectionResponse, IndexerStats, MeResponse } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const setupStatusMock = vi.fn();
const setupTestMock = vi.fn();
const setupCompleteMock = vi.fn();
const adminConnectionMock = vi.fn();
const adminUpdateConnectionMock = vi.fn();
const adminTestConnectionMock = vi.fn();
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

vi.mock("./client.js", () => ({
  apiClient: {
    setupStatus: (...args: unknown[]) => setupStatusMock(...args),
    setupTest: (...args: unknown[]) => setupTestMock(...args),
    setupComplete: (...args: unknown[]) => setupCompleteMock(...args),
    adminConnection: (...args: unknown[]) => adminConnectionMock(...args),
    adminUpdateConnection: (...args: unknown[]) => adminUpdateConnectionMock(...args),
    adminTestConnection: (...args: unknown[]) => adminTestConnectionMock(...args),
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
  },
}));

const ME_RESPONSE: MeResponse = {
  account: { id: "00000000-0000-0000-0000-000000000000", displayName: "Ada" },
  identities: [
    {
      id: "00000000-0000-0000-0000-000000000001",
      username: "ada",
      providerType: "sftpgo",
      providerLabel: "SFTPGo",
    },
  ],
  activeIdentityId: "00000000-0000-0000-0000-000000000001",
  isAdmin: true,
};

const CONNECTION_RESPONSE: AdminConnectionResponse = {
  baseUrl: "http://sftpgo:8080",
  host: "sftpgo:8080",
  homeTemplate: "sftpgo:/{username}",
  source: "env",
  reachable: true,
  checkedAt: "2026-01-01T00:00:00.000Z",
};

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

beforeEach(() => {
  setupStatusMock.mockReset();
  setupTestMock.mockReset();
  setupCompleteMock.mockReset();
  adminConnectionMock.mockReset();
  adminUpdateConnectionMock.mockReset();
  adminTestConnectionMock.mockReset();
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

describe("useAdminConnection", () => {
  it("fetches the active connection", async () => {
    adminConnectionMock.mockResolvedValue(CONNECTION_RESPONSE);
    const { useAdminConnection } = await import("./system-queries.js");
    const queryClient = new QueryClient();

    const { result } = renderHook(() => useAdminConnection(), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.data).toEqual(CONNECTION_RESPONSE));
  });
});

describe("useAdminUpdateConnection", () => {
  it("updates the connection and refreshes the cached summary", async () => {
    const updated = { ...CONNECTION_RESPONSE, homeTemplate: "sftpgo:/new/{username}" };
    adminUpdateConnectionMock.mockResolvedValue(updated);
    const { useAdminUpdateConnection } = await import("./system-queries.js");
    const queryClient = new QueryClient();

    const { result } = renderHook(() => useAdminUpdateConnection(), {
      wrapper: createWrapper(queryClient),
    });
    result.current.mutate({ homeTemplate: "sftpgo:/new/{username}" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData(["admin", "connection"])).toEqual(updated);
  });
});

describe("useAdminTestConnection", () => {
  it("probes the active connection when no baseUrl is given", async () => {
    adminTestConnectionMock.mockResolvedValue({ ok: true, detail: "reachable" });
    const { useAdminTestConnection } = await import("./system-queries.js");
    const queryClient = new QueryClient();

    const { result } = renderHook(() => useAdminTestConnection(), {
      wrapper: createWrapper(queryClient),
    });
    result.current.mutate(undefined);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(adminTestConnectionMock).toHaveBeenCalledWith(undefined);
  });

  it("probes a candidate baseUrl when given", async () => {
    adminTestConnectionMock.mockResolvedValue({ ok: false, detail: "unreachable" });
    const { useAdminTestConnection } = await import("./system-queries.js");
    const queryClient = new QueryClient();

    const { result } = renderHook(() => useAdminTestConnection(), {
      wrapper: createWrapper(queryClient),
    });
    result.current.mutate("http://other:8080");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(adminTestConnectionMock).toHaveBeenCalledWith("http://other:8080");
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
