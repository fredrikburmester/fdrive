import { SystemActivityResponse } from "@fdrive/contracts";
import { expect, test } from "@playwright/test";

/**
 * The system pages normally exercise their network dependencies through
 * `page.route` stubs, so a real route or response-schema drift only fails in
 * production. These smoke tests hit the real API over the real stack
 * (Postgres + SFTPGo + API), and parse the documented contract instead of
 * asserting a hand-written copy of it.
 */
test("the system activity route answers with the documented shape", async ({ page }) => {
  const response = await page.request.get("/api/v1/system/activity");

  expect(response.ok()).toBe(true);
  const body = SystemActivityResponse.parse(await response.json());
  expect(body.items.length).toBeGreaterThan(0);
  expect(body.items.map((item) => item.id)).toContain("storage");
});

test("the OCR originals route reports its unconfigured sidecar, not a fake list", async ({
  page,
}) => {
  // The e2e fixture runs no OCR sidecar, so the real route's only honest answer
  // is the documented bad_request. A 200 here would mean something started
  // inventing originals; a stubbed page.route could never tell the difference.
  const response = await page.request.get("/api/v1/system/ocr/originals?offset=0&limit=5");

  expect(response.status()).toBe(400);
  const body = (await response.json()) as { error: { kind: string; message: string } };
  expect(body.error.kind).toBe("bad_request");
  expect(body.error.message).toMatch(/not configured/i);
});
