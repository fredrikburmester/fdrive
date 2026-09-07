import { expect, type Page } from "@playwright/test";
import { editorExceptionSummary } from "./diagnostics";
import { fixtureState } from "./state";
export async function createDocument(
  page: Page,
  kind: string,
  filename: string,
  format: "ooxml" | "odf" = "ooxml",
) {
  const state = await fixtureState();
  if (state.product === "onlyoffice") await observeOfficeReady(page, state.officeUrl);
  await page.bringToFront();
  await page.goto("/files");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: kind, exact: true }).click();
  if (format === "odf") {
    await page.getByLabel("Format", { exact: true }).click();
    await page.getByRole("option", { name: "OpenDocument", exact: true }).click();
  }
  await page.getByLabel("File name").fill(filename);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByTitle("Office document")).toBeVisible();
  await expect(page.getByText("Opening office…", { exact: true })).toBeHidden({ timeout: 120_000 });
  if (state.product === "onlyoffice") await documentLoaded(page);
  return page
    .frameLocator('iframe[title="Office document"]')
    .frameLocator('iframe[name="frameEditor"]');
}

export async function observeOfficeReady(page: Page, origin: string): Promise<void> {
  page.on("pageerror", (error) => {
    console.log(
      "Editor exception",
      editorExceptionSummary(error.stack ?? `${error.name}: ${error.message}`),
    );
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const summary = editorExceptionSummary(message.text());
    if (summary !== null) console.log("Editor console exception", summary);
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const url = new URL(response.url());
    if (url.origin === origin)
      console.log("Editor HTTP failure", response.status(), response.request().resourceType());
    else if (url.pathname.startsWith("/api/v1/office/"))
      console.log("Office host HTTP failure", response.status());
  });
  await page.addInitScript((expectedOrigin) => {
    if (window !== window.top) return;
    window.addEventListener("message", (event: MessageEvent<unknown>) => {
      const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Office document"]');
      if (event.origin !== expectedOrigin || event.source !== frame?.contentWindow) return;
      let data: unknown = event.data;
      try {
        if (typeof data === "string") data = JSON.parse(data);
      } catch {
        return;
      }
      if (
        typeof data !== "object" ||
        data === null ||
        !("MessageId" in data) ||
        data.MessageId !== "App_LoadingStatus"
      )
        return;
      const values = "Values" in data ? data.Values : null;
      const status =
        typeof values === "object" && values !== null && "Status" in values ? values.Status : null;
      if (typeof status === "string") document.documentElement.dataset.officeLoadingStatus = status;
      if (status === "Document_Loaded")
        document.documentElement.dataset.officeDocumentLoaded = "true";
    });
  }, origin);
}

export async function documentLoaded(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          document.documentElement.dataset.officeDocumentLoaded === "true"
            ? "Document_Loaded"
            : (document.documentElement.dataset.officeLoadingStatus ?? "No loading message"),
        ),
      { timeout: 90_000, message: "Trusted editor Document_Loaded postMessage" },
    )
    .toBe("Document_Loaded");
}
