import { describe, expect, it } from "vitest";
import { apiClient } from "./client.ts";

describe("apiClient", () => {
  it("is a fully built ApiClient with same-origin URLs that name no login", () => {
    expect(typeof apiClient.me).toBe("function");
    expect(typeof apiClient.login).toBe("function");
    expect(apiClient.downloadUrl("/a.txt")).toBe("/api/v1/fs/download?path=%2Fa.txt");
    expect(apiClient.thumbUrl("/a.txt", 256)).toBe("/api/v1/thumb?path=%2Fa.txt&size=256");
  });
});
