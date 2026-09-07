import { StorageError } from "@fdrive/core";
import { describe, expect, it, vi } from "vitest";
import { officeHarness } from "../../test/fixtures/office/harness.ts";
import { WopiError } from "./errors.ts";

describe("office browser routes", () => {
  it("exposes status/open/create contracts and protects token responses", async () => {
    const h = await officeHarness();
    expect((await h.browser("/api/v1/office")).status).toBe(200);
    const open = await h.browser("/api/v1/office/open", {
      path: "/a.docx",
      mode: "edit",
      ui: "sv-SE",
    });
    expect(open.status).toBe(200);
    expect(open.headers.get("Cache-Control")).toBe("no-store");
    expect(open.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(((await open.json()) as { actionUrl: string }).actionUrl).toContain("ui=sv-SE");
    const create = await h.browser("/api/v1/office/documents", { parent: "/", name: "New.docx" });
    expect(create.status).toBe(201);
  });
  it("requires cookies and CSRF even when principal is present", async () => {
    const h = await officeHarness();
    for (const path of ["/api/v1/office/open", "/api/v1/office/documents"]) {
      const body = path.endsWith("open")
        ? { path: "/a.docx", mode: "edit" }
        : { parent: "/", name: "New.docx" };
      expect(
        (
          await h.app.request(path, {
            method: "POST",
            headers: { "x-requested-with": "fdrive", "content-type": "application/json" },
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(401);
      expect(
        (await h.app.request(path, { method: "POST", body: JSON.stringify(body) })).status,
      ).toBe(403);
    }
  });
  it("rejects invalid JSON/schema before use", async () => {
    const h = await officeHarness();
    expect(
      (await h.browser("/api/v1/office/open", { path: "/../a.docx", mode: "edit" })).status,
    ).toBe(400);
    expect(
      (await h.browser("/api/v1/office/documents", { parent: "/", name: "file.exe" })).status,
    ).toBe(400);
  });
  it.each([401, 403, 404, 409, 413, 400, 503])(
    "maps error %s without private messages",
    async (status) => {
      const h = await officeHarness();
      vi.spyOn(h.service, "open").mockRejectedValue(new WopiError(status));
      const response = await h.browser("/api/v1/office/open", { path: "/a.docx", mode: "edit" });
      expect(response.status).toBe(status === 503 ? 502 : status);
      expect(await response.text()).not.toContain("internal URL");
    },
  );
  it("maps document creation failure", async () => {
    const h = await officeHarness();
    vi.spyOn(h.service, "create").mockRejectedValue(new StorageError("conflict", "private"));
    expect(
      (await h.browser("/api/v1/office/documents", { parent: "/", name: "New.docx" })).status,
    ).toBe(409);
  });
});
