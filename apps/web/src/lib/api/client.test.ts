import { describe, expect, it } from "vitest";
import { apiClient } from "./client.ts";

describe("apiClient", () => {
  it("is a fully built ApiClient with a same-origin base URL", () => {
    expect(typeof apiClient.me).toBe("function");
    expect(typeof apiClient.login).toBe("function");
    expect(apiClient.downloadUrl("/a.txt")).toBe("/api/v1/fs/download?path=%2Fa.txt");
  });
});
