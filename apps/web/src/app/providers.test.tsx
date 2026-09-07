// @vitest-environment jsdom
import { useQuery } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useUploadStore } from "@/lib/upload/store";
import { Providers } from "./providers";

vi.mock("next-themes", () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useUploadStore.getState().setOnUploaded(() => {});
});

it("wires upload completion to a fresh listing even during its first request", async () => {
  const stale = Promise.withResolvers<string[]>();
  const query = vi.fn().mockReturnValueOnce(stale.promise).mockResolvedValue(["uploaded.txt"]);
  function Listing() {
    const { data } = useQuery({ queryKey: ["fs", "list", "/"], queryFn: query });
    return <span>{data?.join(",") ?? "Loading"}</span>;
  }
  const registered = vi.spyOn(useUploadStore.getState(), "setOnUploaded");
  render(
    <Providers>
      <Listing />
    </Providers>,
  );
  await waitFor(() => expect(query).toHaveBeenCalledTimes(1));
  const onUploaded = registered.mock.calls[0]?.[0];
  expect(onUploaded).toBeDefined();
  act(() => onUploaded?.("/"));
  await screen.findByText("uploaded.txt");
  await act(async () => {
    stale.resolve([]);
    await stale.promise;
  });
  expect(screen.getByText("uploaded.txt")).toBeDefined();
  expect(query).toHaveBeenCalledTimes(2);
});
