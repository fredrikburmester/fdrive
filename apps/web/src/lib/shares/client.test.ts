import { expect, it, vi } from "vitest";
import { publicShareClient, publicUploadUrl } from "./client";

const id = "00000000-0000-4000-8000-000000000001";
it("uses same-origin capability endpoints without authenticated identity headers", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
  const signal = new AbortController().signal;
  await publicShareClient(signal, fetcher).setSharePassword(id, "input");
  const [url, init] = fetcher.mock.calls[0] ?? [];
  expect(String(url)).toBe(`/api/v1/public/shares/${id}/credentials`);
  expect(init).toMatchObject({ credentials: "same-origin", cache: "no-store", signal });
  expect(new Headers(init?.headers).has("x-identity-id")).toBe(false);
  expect(new Headers(init?.headers).get("x-requested-with")).toBe("fdrive");
  fetcher.mockResolvedValue(Response.json({ ok: true }));
  await publicShareClient(undefined, fetcher).clearSharePassword(id);
  expect(fetcher.mock.calls[1]?.[1]).not.toHaveProperty("signal");
  expect(publicUploadUrl(id, "/日本%20.txt")).toBe(
    `/api/v1/public/shares/${id}/upload?path=%2F%E6%97%A5%E6%9C%AC%2520.txt`,
  );
  expect(() => publicUploadUrl("bad", "/a")).toThrow();
  expect(() => publicUploadUrl(id, "/a/b")).toThrow();
});
