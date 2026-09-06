import { describe, expect, it } from "vitest";
import { apiClient } from "./api-client";

describe("apiClient", () => {
  it("builds a client exposing the fs methods this chunk needs", () => {
    expect(typeof apiClient.list).toBe("function");
    expect(typeof apiClient.mkdir).toBe("function");
    expect(typeof apiClient.move).toBe("function");
    expect(typeof apiClient.copy).toBe("function");
    expect(typeof apiClient.rename).toBe("function");
    expect(typeof apiClient.remove).toBe("function");
    expect(typeof apiClient.zip).toBe("function");
    expect(typeof apiClient.downloadUrl).toBe("function");
  });
});
