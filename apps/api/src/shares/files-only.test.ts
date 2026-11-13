import { ApiError } from "@fdrive/contracts";
import { describe, expect, it } from "vitest";
import { sharesHarness } from "./test-fixtures/index.ts";

const ID = "00000000-0000-4000-8000-000000000001";
/** Every share management route, with a body where the route reads one. */
const MANAGEMENT = [
  { method: "GET", path: "/api/v1/shares" },
  {
    method: "POST",
    path: "/api/v1/shares",
    body: { name: "Document", paths: ["/a.docx"], scope: "read" },
  },
  { method: "GET", path: `/api/v1/shares/${ID}` },
  { method: "PATCH", path: `/api/v1/shares/${ID}`, body: { name: "Renamed" } },
  { method: "DELETE", path: `/api/v1/shares/${ID}` },
] as const;

/**
 * A login on storage without shares is refused with `unsupported` and the
 * capability it lacks, on every management route, before anything reaches
 * the storage: the web reads that kind and capability to state the limit.
 */
async function expectRefusal(
  h: ReturnType<typeof sharesHarness>,
  cookie: string,
  requests: { readonly length: number },
) {
  const seen = requests.length;
  for (const route of MANAGEMENT) {
    const response = await h.request(route.path, {
      cookie,
      method: route.method,
      ...("body" in route ? { body: route.body } : {}),
    });
    expect(response.status, `${route.method} ${route.path}`).toBe(400);
    const { error } = ApiError.parse(await response.json());
    expect(error).toMatchObject({ kind: "unsupported", details: { capability: "shares" } });
  }
  expect(requests.length).toBe(seen);
}

describe("share management for a files-only login", () => {
  it("keeps the same routes open for a local folder login", async () => {
    const h = sharesHarness();
    const cookie = await h.login();
    expect((await h.request("/api/v1/shares", { cookie })).status).toBe(200);
  });

  it("decides by the module's share strategy, never by its type", async () => {
    // The local folder, declared without shares: the type is still "local",
    // so a type check would let it through.
    const h = sharesHarness({ local: (module) => ({ ...module, shares: "none" }) });
    const cookie = await h.login();
    await expectRefusal(h, cookie, { length: 0 });
  });
});
