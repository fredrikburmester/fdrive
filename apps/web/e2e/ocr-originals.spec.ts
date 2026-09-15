import type { OcrOriginal, OcrOriginalsResponse, SystemOcrResponse } from "@fdrive/contracts";
import { expect, type Page, test } from "@playwright/test";

/**
 * `System > Searchable PDFs` against a stubbed OCR service. The real service
 * is not part of the browser stack, and the point here is the administrator's
 * path through the UI: seeing what each kept original would overwrite, being
 * warned before a destructive restore, and what the request carries.
 */
const OCR_STATUS: SystemOcrResponse = {
  configured: true,
  reachable: true,
  health: { ok: true, running: false },
  stats: {
    lastRun: null,
    nextRunAt: null,
    scheduleHour: 3,
    langs: "swe+eng",
    excludeGlobs: [],
    maxMb: 200,
    keepOriginals: true,
    originalsRetentionDays: 0,
    originalsCount: 2,
    originalsBytes: 4096,
    running: false,
  },
  settings: {
    values: {
      hour: 3,
      langs: "swe+eng",
      excludeGlobs: [],
      maxMb: 200,
      keepOriginals: true,
      originalsRetentionDays: 0,
    },
    sources: {
      hour: "default",
      langs: "default",
      excludeGlobs: "default",
      maxMb: "default",
      keepOriginals: "default",
      originalsRetentionDays: "default",
    },
  },
};

const ORIGINALS: OcrOriginal[] = [
  {
    id: "0123456789abcdef_invoice.pdf",
    root: "sftpgo",
    path: "alice/docs/invoice.pdf",
    size: 2048,
    keptAt: new Date(Date.now() - 3_600_000).toISOString(),
    sha256: "a".repeat(64),
    legacy: false,
    state: "ocred",
  },
  {
    id: "fedcba9876543210_receipt.pdf",
    root: "sftpgo",
    path: "alice/docs/receipt.pdf",
    size: 2048,
    keptAt: new Date(Date.now() - 7_200_000).toISOString(),
    sha256: "b".repeat(64),
    legacy: false,
    state: "changed",
  },
];

async function stubOcr(page: Page, onRestore: (body: unknown) => void): Promise<void> {
  await page.route("**/api/v1/system/ocr", (route) => route.fulfill({ json: OCR_STATUS }));
  await page.route("**/api/v1/system/ocr/originals?**", (route) => {
    const body: OcrOriginalsResponse = {
      items: ORIGINALS,
      total: ORIGINALS.length,
      offset: 0,
      limit: 25,
    };
    return route.fulfill({ json: body });
  });
  await page.route("**/api/v1/system/ocr/originals/restore", (route) => {
    onRestore(route.request().postDataJSON());
    return route.fulfill({
      json: {
        restored: true,
        root: "sftpgo",
        path: "alice/docs/receipt.pdf",
        previousState: "changed",
      },
    });
  });
}

test("an administrator restores an original and is warned before overwriting a changed file", async ({
  page,
}) => {
  const restores: unknown[] = [];
  await stubOcr(page, (body) => restores.push(body));

  await page.goto("/system/ocr");
  await expect(page.getByText("Kept originals")).toBeVisible();
  await expect(
    page.getByText("The file each rewrite replaced, kept so a rewrite can be undone."),
  ).toBeVisible();

  await page.getByRole("button", { name: "Manage", exact: true }).click();
  await expect(page.getByText("alice/docs/invoice.pdf")).toBeVisible();
  await expect(page.getByText("Changed since OCR")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("ocr-originals.png"), fullPage: true });

  // The changed file is the one that must not be overwritten silently.
  await page.getByRole("button", { name: "Actions for alice/docs/receipt.pdf" }).click();
  await page.getByRole("menuitem", { name: "Restore" }).click();
  await expect(page.getByText("Overwrite the changed file?")).toBeVisible();
  await expect(page.getByText(/discards those changes permanently/)).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("ocr-restore-warning.png"),
    fullPage: true,
  });

  await page.getByRole("alertdialog").getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("Restored alice/docs/receipt.pdf.")).toBeVisible();
  expect(restores).toEqual([
    {
      id: "fedcba9876543210_receipt.pdf",
      allowRecreate: false,
      allowOverwriteChanged: true,
    },
  ]);
});

test("the settings sheet offers a retention window that keeps originals forever at zero", async ({
  page,
}) => {
  await stubOcr(page, () => undefined);

  await page.goto("/system/ocr");
  await page.getByRole("button", { name: "Settings", exact: true }).click();

  const retention = page.getByLabel("Keep originals for (days)");
  await expect(retention).toHaveValue("0");
  await expect(
    page.getByText("Each pass deletes kept originals older than this. 0 keeps them forever."),
  ).toBeVisible();
});
