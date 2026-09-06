import { describe, expect, it, vi } from "vitest";
import { loadText } from "./text-loader";

function textResponse(text: string, ok = true, status = 200): Response {
  const bytes = new TextEncoder().encode(text);
  return {
    ok,
    status,
    arrayBuffer: () => Promise.resolve(bytes.buffer),
  } as unknown as Response;
}

describe("loadText", () => {
  it("decodes the full body when it is under the limit", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse("hello world"));

    const result = await loadText("/f.txt", fetchImpl, { limit: 1024 });

    expect(result).toEqual({ text: "hello world", truncated: false });
    expect(fetchImpl).toHaveBeenCalledWith("/f.txt");
  });

  it("is not truncated when the body is exactly at the limit", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse("12345"));

    const result = await loadText("/f.txt", fetchImpl, { limit: 5 });

    expect(result).toEqual({ text: "12345", truncated: false });
  });

  it("truncates the body when it exceeds the limit", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse("0123456789"));

    const result = await loadText("/f.txt", fetchImpl, { limit: 5 });

    expect(result).toEqual({ text: "01234", truncated: true });
  });

  it("throws when the response is not ok", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse("", false, 404));

    await expect(loadText("/missing.txt", fetchImpl, { limit: 10 })).rejects.toThrow(/404/);
  });

  it("decodes multi-byte UTF-8 text correctly", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse("héllo — wörld"));

    const result = await loadText("/f.txt", fetchImpl, { limit: 1024 });

    expect(result.text).toBe("héllo — wörld");
    expect(result.truncated).toBe(false);
  });
});
