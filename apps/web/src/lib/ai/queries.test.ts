// @vitest-environment jsdom
import type { OrganizeRun, SystemAiResponse } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/api/keys";

const client = {
  aiStatus: vi.fn(),
  startOrganize: vi.fn(),
  organizeRun: vi.fn(),
  cancelOrganize: vi.fn(),
  moveMany: vi.fn(),
  systemAi: vi.fn(),
  systemUpdateAi: vi.fn(),
  systemTestAi: vi.fn(),
};

vi.mock("@/lib/api/client", () => ({
  apiClient: client,
  snapshotTabApiClient: () => client,
}));

const {
  ORGANIZE_POLL_MS,
  useAiStatus,
  useCancelOrganize,
  useMoveMany,
  useOrganizeRun,
  useStartOrganize,
  useSystemAi,
  useTestSystemAi,
  useUpdateSystemAi,
} = await import("./queries");

function run(state: OrganizeRun["state"]): OrganizeRun {
  return {
    id: "run-1",
    state,
    createdAt: "2026-09-15T10:00:00.000Z",
    updatedAt: "2026-09-15T10:00:00.000Z",
    itemCount: 2,
    activity: [],
  };
}

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return { queryClient, wrapper };
}

beforeEach(() => {
  for (const mock of Object.values(client)) mock.mockReset();
});

describe("AI status and organize runs", () => {
  it("reads whether AI is available", async () => {
    client.aiStatus.mockResolvedValue({ available: true, provider: "anthropic" });
    const { wrapper } = setup();
    const { result } = renderHook(() => useAiStatus(), { wrapper });
    await waitFor(() =>
      expect(result.current.data).toEqual({ available: true, provider: "anthropic" }),
    );
  });

  it("starts a run and polls it only while it is running", async () => {
    client.startOrganize.mockResolvedValue(run("running"));
    client.organizeRun.mockResolvedValueOnce(run("running")).mockResolvedValue(run("done"));
    const { wrapper } = setup();
    const start = renderHook(() => useStartOrganize(), { wrapper });
    await act(() => start.result.current.mutateAsync({ paths: ["/a"] }));
    expect(client.startOrganize).toHaveBeenCalledWith({ paths: ["/a"] });

    const polled = renderHook(() => useOrganizeRun("run-1"), { wrapper });
    await waitFor(() => expect(polled.result.current.data?.state).toBe("running"));
    await waitFor(() => expect(polled.result.current.data?.state).toBe("done"), {
      timeout: ORGANIZE_POLL_MS * 3,
    });
    const calls = client.organizeRun.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, ORGANIZE_POLL_MS + 200));
    expect(client.organizeRun).toHaveBeenCalledTimes(calls);
  });

  it("does not fetch without a run id", () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useOrganizeRun(null), { wrapper });
    expect(result.current.fetchStatus).toBe("idle");
    expect(client.organizeRun).not.toHaveBeenCalled();
  });

  it("stores the cancelled run in the cache", async () => {
    client.cancelOrganize.mockResolvedValue(run("cancelled"));
    const { queryClient, wrapper } = setup();
    const { result } = renderHook(() => useCancelOrganize(), { wrapper });
    await act(() => result.current.mutateAsync("run-1"));
    expect(queryClient.getQueryData(queryKeys.ai.run("run-1"))).toEqual(run("cancelled"));
  });
});

describe("useMoveMany", () => {
  it("refreshes source folders, destinations and their parents after moves", async () => {
    client.moveMany.mockResolvedValue({
      results: [
        { ok: true, path: "/inbox/a.pdf", target: "/Finance/2024/a.pdf" },
        {
          ok: false,
          path: "/inbox/b.pdf",
          target: "/x/b.pdf",
          error: { kind: "conflict", message: "taken" },
        },
      ],
    });
    const { queryClient, wrapper } = setup();
    for (const path of ["/inbox", "/Finance/2024", "/Finance", "/x"])
      queryClient.setQueryData(queryKeys.fs.list(path), { path, entries: [] });
    queryClient.setQueryData(queryKeys.folderViews.all(), {});
    const { result } = renderHook(() => useMoveMany(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        items: [{ path: "/inbox/a.pdf", target: "/Finance/2024/a.pdf" }],
      });
    });

    await waitFor(() => {
      for (const path of ["/inbox", "/Finance/2024", "/Finance"])
        expect(queryClient.getQueryState(queryKeys.fs.list(path))?.isInvalidated).toBe(true);
    });
    expect(queryClient.getQueryState(queryKeys.fs.list("/x"))?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(queryKeys.folderViews.all())?.isInvalidated).toBe(true);
  });

  it("leaves folder views alone when nothing moved", async () => {
    client.moveMany.mockResolvedValue({
      results: [
        { ok: false, path: "/a", target: "/b/a", error: { kind: "conflict", message: "taken" } },
      ],
    });
    const { queryClient, wrapper } = setup();
    queryClient.setQueryData(queryKeys.folderViews.all(), {});
    const { result } = renderHook(() => useMoveMany(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ items: [{ path: "/a", target: "/b/a" }] });
    });
    expect(queryClient.getQueryState(queryKeys.folderViews.all())?.isInvalidated).toBe(false);
  });
});

describe("System AI settings", () => {
  const response: SystemAiResponse = {
    configuration: {
      revision: 1,
      enabled: true,
      provider: "anthropic",
      model: "claude-opus-5",
      baseUrl: null,
      hasApiKey: true,
    },
  };

  it("reads, saves (refreshing AI status) and tests the connection", async () => {
    client.systemAi.mockResolvedValue(response);
    client.systemUpdateAi.mockResolvedValue(response);
    client.systemTestAi.mockResolvedValue({ ok: true, message: "Connected." });
    const { queryClient, wrapper } = setup();
    queryClient.setQueryData(queryKeys.ai.status(), { available: false, provider: null });

    const query = renderHook(() => useSystemAi(), { wrapper });
    await waitFor(() => expect(query.result.current.data).toEqual(response));

    const update = renderHook(() => useUpdateSystemAi(), { wrapper });
    const { hasApiKey: _hasApiKey, ...input } = response.configuration;
    await act(() => update.result.current.mutateAsync(input));
    expect(client.systemUpdateAi).toHaveBeenCalledWith(input);
    expect(queryClient.getQueryState(queryKeys.ai.status())?.isInvalidated).toBe(true);

    const test = renderHook(() => useTestSystemAi(), { wrapper });
    await act(() => test.result.current.mutateAsync());
    expect(client.systemTestAi).toHaveBeenCalled();
  });
});
