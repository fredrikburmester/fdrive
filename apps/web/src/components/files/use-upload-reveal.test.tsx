// @vitest-environment jsdom
import type { ListResponse } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { refreshIdentityQuery } from "@/lib/account/invalidation";
import { queryKeys } from "@/lib/api/keys";
import { type UploadAction, uploadReducer } from "@/lib/upload/queue";
import { useUploadStore } from "@/lib/upload/store";
import type { UploadItem } from "@/lib/upload/types";
import { useUploadReveal } from "./use-upload-reveal";

afterEach(() => useUploadStore.getState().reset());

function item(id: string, overrides: Partial<UploadItem> = {}): UploadItem {
  return {
    id,
    identityId: "alice",
    file: new File([id], id),
    targetPath: `/dest/${id}`,
    relativePath: id,
    size: 1,
    status: "queued",
    progress: 0,
    attempts: 0,
    ...overrides,
  };
}

function dispatch(action: UploadAction) {
  act(() => useUploadStore.setState((s) => ({ state: uploadReducer(s.state, action) })));
}

function listing(paths: string[], path = "/dest"): ListResponse {
  return {
    path,
    entries: paths.map((entryPath) => ({
      path: entryPath,
      name: entryPath.split("/").at(-1) ?? "",
      kind: "file",
      size: 1,
      modifiedAt: "2026-09-14T00:00:00.000Z",
      ext: "txt",
      mime: "text/plain",
    })),
  };
}

function setup(initialPaths: string[] = []) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(queryKeys.fs.list("/dest"), listing(initialPaths));
  client.setQueryData(queryKeys.fs.list("/elsewhere"), listing([], "/elsewhere"));
  const queryFn = vi.fn(async () => listing(initialPaths));
  const onReveal = vi.fn();
  useUploadStore.getState().setActiveIdentity("alice");
  const hook = renderHook(
    ({ path, identityId }) => {
      const query = useQuery({ queryKey: queryKeys.fs.list(path), queryFn });
      useUploadReveal(
        path,
        identityId,
        query.data?.entries.map((entry) => entry.path) ?? [],
        query,
        onReveal,
      );
      return query;
    },
    {
      initialProps: { path: "/dest", identityId: "alice" },
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  return { ...hook, onReveal, client, queryFn };
}

it("waits for the batch and refreshed listing, keeping cleared completions in display order", async () => {
  const { onReveal, queryFn, client } = setup();
  dispatch({ type: "enqueue", items: [item("z.txt"), item("a.txt")] });
  dispatch({ type: "succeed", id: "z.txt" });
  act(() => client.setQueryData(queryKeys.fs.list("/dest"), listing(["/dest/z.txt"])));
  expect(onReveal).not.toHaveBeenCalled();
  expect(queryFn).not.toHaveBeenCalled();
  dispatch({ type: "clearFinished" });
  queryFn.mockResolvedValue(listing(["/dest/a.txt", "/dest/z.txt"]));
  dispatch({ type: "succeed", id: "a.txt" });
  expect(onReveal).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(onReveal).toHaveBeenCalledExactlyOnceWith(["/dest/a.txt", "/dest/z.txt"]),
  );
  dispatch({ type: "clearFinished" });
  expect(onReveal).toHaveBeenCalledTimes(1);
});

it("reveals successes, deduplicating dropped folders and ignoring other destinations", async () => {
  const { onReveal, queryFn } = setup();
  queryFn.mockResolvedValue(listing(["/dest/folder"]));
  dispatch({
    type: "enqueue",
    items: [
      item("folder/a.txt"),
      item("folder/b.txt"),
      item("bad.txt", { status: "error" }),
      item("skipped.txt", { status: "skipped" }),
      item("cancelled.txt", { status: "cancelled" }),
      item("elsewhere.txt", { targetPath: "/elsewhere/elsewhere.txt" }),
      item("other-login.txt", { identityId: "bob" }),
    ],
  });
  dispatch({ type: "succeed", id: "folder/a.txt" });
  dispatch({ type: "succeed", id: "folder/b.txt" });
  await waitFor(() => expect(onReveal).toHaveBeenCalledExactlyOnceWith(["/dest/folder"]));
});

it("waits for a replacement refresh and rendered sort even when another callback restarts it", async () => {
  const { onReveal, queryFn, client } = setup(["/dest/a.txt", "/dest/z.txt"]);
  const refresh = Promise.withResolvers<ListResponse>();
  queryFn.mockReturnValue(refresh.promise);
  dispatch({ type: "enqueue", items: [item("a.txt"), item("z.txt")] });
  dispatch({ type: "succeed", id: "a.txt" });
  dispatch({ type: "succeed", id: "z.txt" });
  await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));
  // The queue's onUploaded callback also invalidates this listing.
  act(() => {
    void refreshIdentityQuery(client, queryKeys.fs.list("/dest"));
  });
  await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
  expect(onReveal).not.toHaveBeenCalled();
  await act(async () => refresh.resolve(listing(["/dest/z.txt", "/dest/a.txt"])));
  await waitFor(() =>
    expect(onReveal).toHaveBeenCalledExactlyOnceWith(["/dest/z.txt", "/dest/a.txt"]),
  );
});

it.each(["fail", "cancel"] as const)("reveals a successful retry after %s", async (type) => {
  const { onReveal, queryFn } = setup();
  dispatch({ type: "enqueue", items: [item("a.txt")] });
  dispatch({ type: "start", id: "a.txt" });
  dispatch({ type, id: "a.txt", message: "network interrupted" });
  expect(onReveal).not.toHaveBeenCalled();
  dispatch({ type: "retry", id: "a.txt" });
  dispatch({ type: "start", id: "a.txt" });
  queryFn.mockResolvedValue(listing(["/dest/a.txt"]));
  dispatch({ type: "succeed", id: "a.txt" });
  await waitFor(() => expect(onReveal).toHaveBeenCalledExactlyOnceWith(["/dest/a.txt"]));
});

it.each([{ remaining: [] }, { remaining: ["/dest/renamed-a.txt"] }])(
  "reveals surviving uploads when an earlier path is missing: $remaining",
  async ({ remaining }) => {
    const { onReveal, queryFn, client } = setup();
    dispatch({ type: "enqueue", items: [item("a.txt"), item("b.txt")] });
    dispatch({ type: "succeed", id: "a.txt" });
    act(() => client.setQueryData(queryKeys.fs.list("/dest"), listing(remaining)));
    queryFn.mockResolvedValue(listing([...remaining, "/dest/b.txt"]));
    dispatch({ type: "succeed", id: "b.txt" });
    await waitFor(() => expect(onReveal).toHaveBeenCalledExactlyOnceWith(["/dest/b.txt"]));
  },
);

it("consumes a fully removed batch without selecting a later file at the same path", async () => {
  const { onReveal, queryFn, client, result } = setup();
  dispatch({ type: "enqueue", items: [item("a.txt")] });
  dispatch({ type: "succeed", id: "a.txt" });
  await waitFor(() => {
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(result.current.isFetching).toBe(false);
  });
  await act(async () => client.setQueryData(queryKeys.fs.list("/dest"), listing(["/dest/a.txt"])));
  expect(onReveal).not.toHaveBeenCalled();
});

it("does not reveal failed, skipped or cancelled batches", () => {
  const { onReveal, queryFn } = setup();
  dispatch({ type: "enqueue", items: [item("bad", { status: "error" })] });
  dispatch({ type: "enqueue", items: [item("skip", { status: "skipped" })] });
  dispatch({ type: "enqueue", items: [item("cancel")] });
  dispatch({ type: "cancel", id: "cancel" });
  expect(onReveal).not.toHaveBeenCalled();
  expect(queryFn).not.toHaveBeenCalled();
});

it("does not replay old uploads or reveal after leaving and returning during refresh", async () => {
  dispatch({ type: "enqueue", items: [item("old.txt")] });
  const { rerender, onReveal, queryFn } = setup();
  const refresh = Promise.withResolvers<ListResponse>();
  queryFn.mockReturnValue(refresh.promise);
  dispatch({ type: "succeed", id: "old.txt" });
  dispatch({ type: "enqueue", items: [item("new.txt")] });
  dispatch({ type: "succeed", id: "new.txt" });
  await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));
  rerender({ path: "/elsewhere", identityId: "alice" });
  rerender({ path: "/dest", identityId: "alice" });
  await act(async () => refresh.resolve(listing(["/dest/old.txt", "/dest/new.txt"])));
  expect(onReveal).not.toHaveBeenCalled();
});

it("abandons completions on an identity switch before the browser receives the new identity", async () => {
  const { onReveal, queryFn } = setup();
  const refresh = Promise.withResolvers<ListResponse>();
  queryFn.mockReturnValue(refresh.promise);
  dispatch({ type: "enqueue", items: [item("a.txt")] });
  dispatch({ type: "succeed", id: "a.txt" });
  await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));
  act(() => useUploadStore.getState().setActiveIdentity("bob"));
  act(() => useUploadStore.getState().setActiveIdentity("alice"));
  await act(async () => refresh.resolve(listing(["/dest/a.txt"])));
  expect(onReveal).not.toHaveBeenCalled();
});

it("reveals unchanged replacements separately and unsubscribes on unmount", async () => {
  const { onReveal, unmount } = setup(["/dest/a.txt"]);
  dispatch({ type: "enqueue", items: [item("a.txt")] });
  dispatch({ type: "succeed", id: "a.txt" });
  await waitFor(() => expect(onReveal).toHaveBeenCalledTimes(1));
  dispatch({
    type: "enqueue",
    items: [item("replacement", { relativePath: "a.txt", targetPath: "/dest/a.txt" })],
  });
  dispatch({ type: "succeed", id: "replacement" });
  await waitFor(() => expect(onReveal).toHaveBeenCalledTimes(2));
  unmount();
  dispatch({ type: "enqueue", items: [item("after.txt")] });
  dispatch({ type: "succeed", id: "after.txt" });
  expect(onReveal).toHaveBeenCalledTimes(2);
});
