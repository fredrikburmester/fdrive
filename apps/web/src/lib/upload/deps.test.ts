import type { ApiClient } from "@fdrive/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiClient, createDefaultOnUploaded, queryKeys } from "./deps.ts";

describe("deps", () => {
  it("queryKeys.fs.list builds a stable, path-scoped key", () => {
    expect(queryKeys.fs.list("/a/b")).toEqual(["fs", "list", "/a/b"]);
  });

  it("exposes an apiClient with the ApiClient surface", () => {
    expect(typeof apiClient.list).toBe("function");
    expect(typeof apiClient.upload).toBe("function");
  });
});

describe("createDefaultOnUploaded", () => {
  it("computes the query key and asks the client to refresh the listing", () => {
    const list = vi.fn().mockResolvedValue({ path: "/a", entries: [] });
    const fakeClient: Pick<ApiClient, "list"> = { list };
    const fakeKeysList = vi.fn().mockReturnValue(["fs", "list", "/a"]);
    const fakeKeys = { fs: { list: fakeKeysList } };

    const onUploaded = createDefaultOnUploaded(fakeClient, fakeKeys);
    onUploaded("/a");

    expect(fakeKeysList).toHaveBeenCalledWith("/a");
    expect(list).toHaveBeenCalledWith("/a");
  });

  it("swallows a rejected refresh", async () => {
    const list = vi.fn().mockRejectedValue(new Error("network down"));
    const onUploaded = createDefaultOnUploaded({ list }, queryKeys);

    expect(() => onUploaded("/a")).not.toThrow();
    // Let the rejected promise's .catch settle before the test ends.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("uses the real stand-ins by default", async () => {
    const listSpy = vi.spyOn(apiClient, "list").mockResolvedValue({ path: "/a", entries: [] });

    const onUploaded = createDefaultOnUploaded();
    onUploaded("/a");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(listSpy).toHaveBeenCalledWith("/a");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
