// @vitest-environment jsdom
import type { IdentityScopeResponse } from "@fdrive/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  mounts: vi.fn(),
  setMounts: vi.fn(),
  suggestions: vi.fn(),
}));
vi.mock("./client", () => ({
  apiClient: {
    identityScope: mocks.get,
    setIdentityScope: mocks.put,
    mountMappings: mocks.mounts,
    setMountMappings: mocks.setMounts,
    identityScopeSuggestions: mocks.suggestions,
  },
}));

import {
  useIdentityScope,
  useIdentityScopeSuggestions,
  useMountMappings,
  useSetIdentityScope,
  useSetMountMappings,
} from "./scope-queries";

const unmapped: IdentityScopeResponse = {
  status: "unavailable",
  reason: "unmapped_mount",
  usesOverride: false,
  virtualPrefixes: ["/"],
  unmappedMounts: [{ virtualPath: "/shared", kind: "dir" }],
  unverifiedPrefixes: [],
  unindexedPrefixes: [],
  warning: "warning",
  isAdmin: false,
};

it("loads the status once and renders the PUT result without a follow-up GET", async () => {
  const mapped: IdentityScopeResponse = {
    ...unmapped,
    status: "available",
    reason: "ok",
    usesOverride: true,
    unmappedMounts: [],
  };
  mocks.get.mockResolvedValue(unmapped);
  mocks.put.mockResolvedValue(mapped);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );

  const { result } = renderHook(
    () => ({ scope: useIdentityScope("id-1"), save: useSetIdentityScope("id-1") }),
    { wrapper },
  );
  await waitFor(() => expect(result.current.scope.data).toEqual(unmapped));
  expect(mocks.get).toHaveBeenCalledWith("id-1");

  await act(async () => {
    await result.current.save.mutateAsync({ scopes: [], unindexedPrefixes: ["/shared"] });
  });
  expect(mocks.put).toHaveBeenCalledWith("id-1", { scopes: [], unindexedPrefixes: ["/shared"] });
  await waitFor(() => expect(result.current.scope.data).toEqual(mapped));
  expect(mocks.get).toHaveBeenCalledTimes(1);
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["search"] });
});

it("replaces folder mappings and refetches every login's status and suggestions", async () => {
  const mappings = {
    mappings: [{ virtualPath: "/shared", rootName: "sftpgo", fsPrefix: "/_folders/shared" }],
  };
  mocks.mounts.mockResolvedValue({ mappings: [] });
  mocks.setMounts.mockResolvedValue(mappings);
  mocks.suggestions.mockResolvedValue({ mounts: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(
    () => ({
      mounts: useMountMappings(),
      save: useSetMountMappings(),
      suggestions: useIdentityScopeSuggestions("id-1", true),
      gated: useIdentityScopeSuggestions("id-2", false),
    }),
    { wrapper },
  );
  await waitFor(() => expect(result.current.mounts.data).toEqual({ mappings: [] }));
  await waitFor(() => expect(result.current.suggestions.data).toEqual({ mounts: [] }));
  expect(mocks.suggestions).toHaveBeenCalledTimes(1);
  expect(mocks.suggestions).toHaveBeenCalledWith("id-1");

  await act(async () => {
    await result.current.save.mutateAsync(mappings);
  });
  await waitFor(() => expect(result.current.mounts.data).toEqual(mappings));
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["account", "identity-scope"] });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["search"] });
});
