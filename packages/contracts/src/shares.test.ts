import { describe, expect, it } from "vitest";
import { createApiClient } from "./client.ts";
import { publicShareRoute, shareRoute } from "./routes.ts";
import {
  CreateShareRequest,
  isImageFileName,
  PublicShare,
  SharePath,
  ShareUploadPath,
  UpdateShareRequest,
} from "./shares.ts";

const id = "00000000-0000-4000-8000-000000000001";
describe("share contracts", () => {
  it("accepts canonical paths and rejects traversal, separators, control and double decoding", () => {
    for (const value of ["/", "/a b/文.docx", "/literal%20.txt", "/a%2fb"])
      expect(SharePath.safeParse(value).success).toBe(true);
    for (const value of ["", "relative", "/a/", "/a//b", "/a/../b", "/./b", "/a\\b", "/a\0"])
      expect(SharePath.safeParse(value).success).toBe(false);
    expect(ShareUploadPath.safeParse("/a.docx").success).toBe(true);
    for (const value of ["/", "/a/b"]) expect(ShareUploadPath.safeParse(value).success).toBe(false);
  });
  it("defaults create fields and preserves omitted update password", () => {
    const input = CreateShareRequest.parse({ name: "Docs", paths: ["/a"], scope: "read" });
    expect(input).toEqual({
      name: "Docs",
      paths: ["/a"],
      scope: "read",
      description: "",
      expiresAt: null,
      maxDownloads: 0,
      presentation: "auto",
    });
    expect(UpdateShareRequest.parse({ name: "New" })).toEqual({ name: "New" });
    expect(CreateShareRequest.safeParse({ ...input, presentation: "slideshow" }).success).toBe(
      false,
    );
    expect(CreateShareRequest.safeParse({ ...input, allowFrom: [] }).success).toBe(false);
    expect(CreateShareRequest.safeParse({ ...input, paths: [] }).success).toBe(false);
    expect(CreateShareRequest.safeParse({ ...input, password: "a".repeat(1025) }).success).toBe(
      false,
    );
    expect(publicShareRoute("a/b")).toContain("a%2Fb");
    expect(shareRoute("a/b")).toContain("a%2Fb");
  });
  it("drives all typed share client methods", async () => {
    const managed = {
      id,
      name: "Doc",
      description: "",
      scope: "read",
      paths: ["/a"],
      publicPath: `/s/${id}`,
      hasPassword: false,
      expiresAt: null,
      maxDownloads: 0,
      usedDownloads: 0,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      presentation: "auto",
    };
    const pub = PublicShare.parse({
      ...managed,
      layout: "single-file",
      fileName: "a",
      credentialPresent: false,
      unavailableReason: null,
    });
    const seen: Request[] = [];
    const client = createApiClient({
      fetch: async (input, init) => {
        const request = new Request(`http://test${input}`, init);
        seen.push(request);
        const path = new URL(request.url).pathname;
        const body = path.endsWith("archive-entries")
          ? { format: "zip", entries: [], truncated: false }
          : path.endsWith("entries")
            ? { items: [] }
            : path.includes("credentials") || path.endsWith("upload") || request.method === "DELETE"
              ? { ok: true }
              : path.includes("public")
                ? pub
                : path.endsWith("shares") && request.method === "GET"
                  ? { items: [managed] }
                  : managed;
        return Response.json(body);
      },
    });
    const input = CreateShareRequest.parse({ name: "Doc", paths: ["/a"], scope: "read" });
    await client.listShares();
    await client.createShare(input);
    await client.getShare(id);
    await client.updateShare(id, { password: "" });
    await client.deleteShare(id);
    await client.publicShare(id);
    await client.setSharePassword(id, "secret");
    await client.clearSharePassword(id);
    await client.shareEntries(id);
    await client.shareEntries(id, "/child");
    await client.shareArchiveEntries(id);
    await client.shareArchiveEntries(id, "/child.zip");
    await client.shareUpload(id, "/a", new Uint8Array([1]));
    expect(client.shareDownloadUrl(id)).toContain("path=%2F");
    expect(client.shareDownloadUrl(id, "/b")).toContain("path=%2Fb");
    expect(client.shareArchiveUrl(id)).toContain("/archive");
    expect(seen).toHaveLength(13);
    expect(
      seen
        .filter((r) => r.method !== "GET")
        .every((r) => r.headers.get("x-requested-with") === "fdrive"),
    ).toBe(true);
  });
  it("recognizes image extensions case-insensitively and rejects names without one", () => {
    for (const name of ["photo.png", "PHOTO.PNG", "a.b.JPEG", "x.webp", "x.gif", "x.bmp", "x.avif"])
      expect(isImageFileName(name)).toBe(true);
    for (const name of ["photo.svg", "photo", "photo.", "photo.txt", "photo.pdf"])
      expect(isImageFileName(name)).toBe(false);
  });
});
