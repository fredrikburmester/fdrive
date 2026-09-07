// @vitest-environment jsdom
import type { MeResponse } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { accountTransition, transitionAccount } from "@/lib/account/transition";
import { apiClient } from "@/lib/api/client";
import { useJobsStore } from "@/lib/jobs/store";
import { useSearchShortcut } from "@/lib/search/shortcut";
import { ShellRuntime } from "./shell-runtime";

vi.mock("@/components/upload/upload-provider", () => ({
  UploadFilesProvider: ({ children }: { children: React.ReactNode }) => children,
}));
const me: MeResponse = {
  account: { id: "a", displayName: "Ada" },
  identities: [],
  activeIdentityId: "one",
  isAdmin: false,
};
function StatefulChild() {
  const [count, setCount] = useState(0);
  const { open } = useSearchShortcut();
  return (
    <>
      <button type="button" onClick={() => setCount(count + 1)}>
        Selection {count}
      </button>
      {createPortal(<button type="button">Private portal</button>, document.body)}
      {open ? createPortal(<span role="dialog">Search portal</span>, document.body) : null}
    </>
  );
}
afterEach(() => {
  cleanup();
  accountTransition.finish(false);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("masks portal and page state, preserves state on failure, resets it after success", async () => {
  const close = vi.fn();
  vi.stubGlobal(
    "EventSource",
    class {
      close = close;
      addEventListener() {}
    },
  );
  vi.spyOn(apiClient, "me").mockResolvedValue(me);
  vi.spyOn(apiClient, "jobs").mockResolvedValue([]);
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["auth", "me"], me);
  render(
    <QueryClientProvider client={client}>
      <ShellRuntime>
        <StatefulChild />
      </ShellRuntime>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Selection 0" }));
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  expect(screen.getByRole("dialog").textContent).toBe("Search portal");
  act(() => accountTransition.begin());
  expect(screen.queryByRole("button", { name: "Selection 1" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Private portal" })).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("Updating logins…");
  expect(close).toHaveBeenCalled();
  act(() => accountTransition.finish(false));
  expect(screen.getByRole("button", { name: "Selection 1" })).toBeDefined();
  expect(screen.getByRole("dialog").textContent).toBe("Search portal");
  await act(async () => {
    await transitionAccount(
      client,
      async () => ({ ...me, activeIdentityId: "two" }),
      () => {},
    );
  });
  expect(screen.getByRole("button", { name: "Selection 0" })).toBeDefined();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("button", { name: "Private portal" })).toBeDefined();
});

it("ignores a jobs response that arrives after the old runtime was hidden", async () => {
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
  render(
    <QueryClientProvider client={client}>
      <ShellRuntime>
        <span>Files</span>
      </ShellRuntime>
    </QueryClientProvider>,
  );
  act(() => accountTransition.begin());
  await act(async () => {
    finish?.([
      {
        id: "old",
        kind: "compress",
        state: "done",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        progress: { processed: 1, total: 1, bytes: 1 },
      },
    ]);
  });
  await waitFor(() => expect(useJobsStore.getState().state.order).toEqual([]));
});

it("hydrates a matching loading shell before mounting Activity and routing children", async () => {
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
