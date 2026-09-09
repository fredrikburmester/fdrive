// @vitest-environment jsdom
import type { SystemLogsResponse } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const systemLogsMock = vi.fn();

vi.mock("./client.js", () => ({
  apiClient: {
    systemLogs: (...args: unknown[]) => systemLogsMock(...args),
  },
}));

const { useSystemLogs } = await import("./system-logs-queries");

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client }, children);
}

function page(ids: string[], nextCursor?: string): SystemLogsResponse {
  return {
    subsystem: "indexer",
    entries: ids.map((id) => ({
      id,
      at: "2026-09-09T10:00:00.000Z",
      level: "info",
      message: id,
      source: "api",
    })),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

describe("useSystemLogs", () => {
  beforeEach(() => {
    systemLogsMock.mockReset();
  });

  it("does not fetch while disabled", () => {
    const { result } = renderHook(
      () => useSystemLogs("indexer", { level: "info", enabled: false }),
      { wrapper },
    );
    expect(result.current.fetchStatus).toBe("idle");
    expect(systemLogsMock).not.toHaveBeenCalled();
  });

  it("fetches the first page with the level and pages older entries with the cursor", async () => {
    systemLogsMock
      .mockResolvedValueOnce(page(["api:3", "api:2"], "2026-09-09T09:00:00.000Z"))
      .mockResolvedValueOnce(page(["api:1"]));
    const { result } = renderHook(
      () => useSystemLogs("indexer", { level: "warn", enabled: true }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(systemLogsMock).toHaveBeenCalledWith("indexer", { level: "warn" });
    expect(result.current.hasNextPage).toBe(true);

    await act(async () => {
      await result.current.fetchNextPage();
    });
    expect(systemLogsMock).toHaveBeenLastCalledWith("indexer", {
      level: "warn",
      before: "2026-09-09T09:00:00.000Z",
    });
    await waitFor(() => expect(result.current.hasNextPage).toBe(false));
    expect(result.current.data?.pages.flatMap((p) => p.entries.map((e) => e.id))).toEqual([
      "api:3",
      "api:2",
      "api:1",
    ]);
  });
});
