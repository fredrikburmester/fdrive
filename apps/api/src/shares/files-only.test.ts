import { ApiError } from "@fdrive/contracts";
import { createFakeS3Server, s3Module } from "@fdrive/s3";
import { createFakeWebdavServer, webdavModule } from "@fdrive/webdav";
import { describe, expect, it } from "vitest";
import { seedS3Provider, seedWebdavProvider } from "../providers/test-fixtures/index.ts";
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

function hostOf(url: string | URL | Request): string {
  return new URL(url instanceof Request ? url.url : String(url)).host;
}

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
  it("refuses a WebDAV login with unsupported and touches no storage", async () => {
    const dav = createFakeWebdavServer({
      users: [{ username: "dana", password: "dana-pass" }],
      origin: "http://dav.test",
      prefix: "/dav",
    });
    const h = sharesHarness({
      modules: { webdav: webdavModule },
      wrapFetch: (fetch) => (url, init) =>
        hostOf(url) === "dav.test" ? dav.fetch(url, init) : fetch(url, init),
    });
    const row = await seedWebdavProvider(h.repos, "http://dav.test/dav", { label: "Team drive" });
    const cookie = await h.login("dana", { providerId: row.id });
    await expectRefusal(h, cookie, dav.requests);
  });

  it("refuses an S3 login with unsupported and touches no storage", async () => {
    const key = { accessKeyId: "dana-key", secretAccessKey: "dana-secret" };
    const s3 = createFakeS3Server({ keys: [key], buckets: ["media"] });
    const h = sharesHarness({
      modules: { s3: s3Module },
      wrapFetch: (fetch) => (url, init) =>
        hostOf(url) === "s3.test" ? s3.fetch(url, init) : fetch(url, init),
    });
    const row = await seedS3Provider(h.repos, "http://s3.test/media/team", {
      label: "Photos",
      region: "eu-west-1",
    });
    const cookie = await h.login(key.accessKeyId, {
      providerId: row.id,
      password: key.secretAccessKey,
    });
    await expectRefusal(h, cookie, s3.requests);
  });

  it("keeps the same routes open for an SFTPGo login", async () => {
    const h = sharesHarness();
    const cookie = await h.login();
    expect((await h.request("/api/v1/shares", { cookie })).status).toBe(200);
  });
});
