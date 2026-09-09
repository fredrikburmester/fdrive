// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { apiClient } from "@/lib/api/client";
import { SharedFoldersCard } from "./shared-folders-card";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SharedFoldersCard />
    </QueryClientProvider>,
  );
}

it("explains the empty state", async () => {
  vi.spyOn(apiClient, "mountMappings").mockResolvedValue({ mappings: [] });
  renderCard();
  await waitFor(() => expect(screen.getByText(/No shared folder mappings yet/)).toBeDefined());
});

it("lists mappings and removes one with a whole-list PUT", async () => {
  vi.spyOn(apiClient, "mountMappings").mockResolvedValue({
    mappings: [
      { virtualPath: "/shared", rootName: "sftpgo", fsPrefix: "/_folders/shared" },
      { virtualPath: "/team", rootName: "sftpgo", fsPrefix: "/_folders/team" },
    ],
  });
  const put = vi.spyOn(apiClient, "setMountMappings").mockResolvedValue({
    mappings: [{ virtualPath: "/team", rootName: "sftpgo", fsPrefix: "/_folders/team" }],
  });
  renderCard();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Remove shared folder /shared" })).toBeDefined(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Remove shared folder /shared" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Remove shared folder /shared" })).toBeNull(),
  );
  expect(put).toHaveBeenCalledWith({
    mappings: [{ virtualPath: "/team", rootName: "sftpgo", fsPrefix: "/_folders/team" }],
  });
  expect(screen.getByRole("button", { name: "Remove shared folder /team" })).toBeDefined();
});
