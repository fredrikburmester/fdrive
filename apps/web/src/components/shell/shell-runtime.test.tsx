// @vitest-environment jsdom
import type { JobStatus } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { apiClient } from "@/lib/api/client";
import { useJobsStore } from "@/lib/jobs/store";
import { makeMe } from "@/test-fixtures/identity";
import { ShellRuntime } from "./shell-runtime";

vi.mock("@/components/upload/upload-provider", () => ({
  UploadFilesProvider: ({ children }: { children: React.ReactNode }) => children,
}));
const me = makeMe();
const doneJob: JobStatus = {
  id: "old",
  kind: "compress",
  state: "done",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  progress: { processed: 1, total: 1, bytes: 1 },
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("hydrates jobs and opens one event stream once mounted", async () => {
  const opened: string[] = [];
  vi.stubGlobal(
    "EventSource",
    class {
      constructor(url: string) {
        opened.push(url);
      }
      close() {}
      addEventListener() {}
    },
  );
  vi.spyOn(apiClient, "me").mockResolvedValue(me);
  vi.spyOn(apiClient, "encryptionStatus").mockResolvedValue({ enabled: false });
  const jobs = vi.spyOn(apiClient, "jobs").mockResolvedValue([doneJob]);
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["auth", "me"], me);
  useJobsStore.getState().reset();
  render(
    <QueryClientProvider client={client}>
      <ShellRuntime>
        <span>Files</span>
      </ShellRuntime>
    </QueryClientProvider>,
  );
  expect(screen.getByText("Files")).toBeDefined();
  await waitFor(() => expect(useJobsStore.getState().state.order).toEqual(["old"]));
  expect(jobs).toHaveBeenCalledTimes(1);
  expect(opened).toEqual(["/api/v1/events"]);
  useJobsStore.getState().reset();
});

it("ignores a jobs response that arrives after the runtime unmounted", async () => {
  vi.stubGlobal(
    "EventSource",
    class {
      close() {}
      addEventListener() {}
    },
  );
  vi.spyOn(apiClient, "me").mockResolvedValue(me);
  let finish: ((jobs: Awaited<ReturnType<typeof apiClient.jobs>>) => void) | undefined;
  vi.spyOn(apiClient, "jobs")
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue([]);
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["auth", "me"], me);
  useJobsStore.getState().reset();
  const { unmount } = render(
    <QueryClientProvider client={client}>
      <ShellRuntime>
        <span>Files</span>
      </ShellRuntime>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(finish).toBeDefined());
  unmount();
  await act(async () => {
    finish?.([doneJob]);
  });
  await waitFor(() => expect(useJobsStore.getState().state.order).toEqual([]));
});

it("hydrates a matching loading shell before mounting routing children", async () => {
  vi.stubGlobal(
    "EventSource",
    class {
      close() {}
      addEventListener() {}
    },
  );
  vi.spyOn(apiClient, "me").mockResolvedValue(me);
  vi.spyOn(apiClient, "jobs").mockResolvedValue([]);
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["auth", "me"], me);
  const tree = (
    <QueryClientProvider client={client}>
      <ShellRuntime>
        <span>Hydrated files</span>
      </ShellRuntime>
    </QueryClientProvider>
  );
  const html = renderToString(tree);
  expect(html).toContain("Loading fdrive");
  expect(html).not.toContain("Hydrated files");
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.append(container);
  const recoverableError = vi.fn();
  let root: Root | undefined;
  try {
    await act(async () => {
      root = hydrateRoot(container, tree, { onRecoverableError: recoverableError });
    });
    expect(screen.queryByText("Loading fdrive…")).toBeNull();
    expect(screen.getByText("Hydrated files")).toBeDefined();
    expect(recoverableError).not.toHaveBeenCalled();
  } finally {
    act(() => root?.unmount());
    container.remove();
  }
});
