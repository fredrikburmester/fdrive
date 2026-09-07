/** Production browser probe. Resource responseEnd predates parsing/rendering, even if callbacks run late. */

import { writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { readinessScript } from "./ready-script.js";

const baseUrl = process.env.PERF_WEB_URL;
const cookie = process.env.PERF_COOKIE;
const output = process.env.PERF_UI_OUTPUT;
if (!baseUrl || !cookie || !output) throw Error("Performance browser environment missing");
const browser = await chromium.launch({ headless: true });
interface BrowserStats {
  listingRequests: number;
  listingPaths: Record<string, number>;
  longTasksMs: number[];
}
const results: Record<
  string,
  { samplesMs: number[]; maxMounted: number; verifiedCount: number; diagnostics: unknown[] }
> = {};
try {
  for (const mode of ["list", "grid"] as const) {
    const samplesMs: number[] = [];
    let maxMounted = 0;
    const diagnostics: unknown[] = [];
    for (let index = 0; index < 5; index++) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        reducedMotion: "reduce",
      });
      try {
        const separator = cookie.indexOf("=");
        await context.addCookies([
          { name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: baseUrl },
        ]);
        await context.addInitScript(
          (value) => localStorage.setItem("fdrive.view", JSON.stringify(value)),
          mode,
        );
        await context.addInitScript({ content: `(${readinessScript})(${JSON.stringify(mode)})` });
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        const responsePromise = page.waitForResponse((res) => {
          const url = new URL(res.url());
          return url.pathname === "/api/v1/fs/list" && url.searchParams.get("path") === "/flat-10k";
        });
        await writeFile(
          output,
          JSON.stringify({ progress: { mode, index, phase: "navigate" }, results, samplesMs }),
        );
        await page.goto(`${baseUrl}/files/flat-10k`, { waitUntil: "domcontentloaded" });
        const response = await responsePromise;
        if (!response.ok()) throw Error(`UI listing failed: ${response.status()}`);
        await page
          .waitForFunction(
            () =>
              (window as typeof window & { fdrivePerfReady?: number }).fdrivePerfReady !==
              undefined,
          )
          .catch(async () => {
            const body: unknown = await response.json();
            const state = await page.evaluate(() => ({
              path: location.pathname,
              rows: document.querySelectorAll("[data-path]").length,
              slot: document
                .querySelector("[data-slot=file-list], [data-slot=file-grid]")
                ?.getAttribute("data-slot"),
              stats: (window as typeof window & { fdrivePerfStats?: BrowserStats }).fdrivePerfStats,
            }));
            const count =
              typeof body === "object" &&
              body !== null &&
              "entries" in body &&
              Array.isArray(body.entries)
                ? body.entries.length
                : "missing";
            throw Error(
              `Ready mark missing: status=${response.status()} count=${count} keys=${typeof body === "object" && body !== null ? Object.keys(body).join(",") : typeof body}; ${JSON.stringify(state)}`,
            );
          });
        const elapsed = await page.evaluate(
          () => (window as typeof window & { fdrivePerfReady?: number }).fdrivePerfReady,
        );
        if (elapsed === undefined || !Number.isFinite(elapsed) || elapsed <= 0)
          throw Error("Invalid UI ready timing");
        await writeFile(
          output,
          JSON.stringify({
            progress: { mode, index, phase: "ready", elapsed },
            results,
            samplesMs,
          }),
        );
        const raw: unknown = await response.json();
        if (
          typeof raw !== "object" ||
          raw === null ||
          !("entries" in raw) ||
          !Array.isArray(raw.entries) ||
          raw.entries.length !== 10000
        )
          throw Error(
            `UI fixture is not 10000 entries: mode=${mode} sample=${index + 1} count=${typeof raw === "object" && raw !== null && "entries" in raw && Array.isArray(raw.entries) ? raw.entries.length : "missing"}`,
          );
        const region = page.locator(`[data-slot="file-${mode}"]`);
        const layout = await region.evaluate((element) => ({
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
          rows: element.querySelectorAll("[data-path]").length,
          viewportHeight: innerHeight,
        }));
        await writeFile(
          output,
          JSON.stringify({
            progress: { mode, index, phase: "layout", elapsed, layout },
            results,
            samplesMs,
            diagnostics,
          }),
        );
        const first = region.locator('[data-path="/flat-10k/00000.bin"]');
        await first.waitFor({ state: "visible" });
        maxMounted = Math.max(maxMounted, await region.locator("[data-path]").count());
        await first.click({ noWaitAfter: true });
        await page.waitForFunction(
          () =>
            document
              .querySelector('[data-path="/flat-10k/00000.bin"]')
              ?.getAttribute("data-selected") === "true",
        );
        await page.keyboard.press("ArrowDown");
        await page.waitForFunction(
          () =>
            document
              .querySelector('[data-path="/flat-10k/00001.bin"]')
              ?.getAttribute("data-selected") === "true",
        );
        await region.evaluate((element, view) => {
          const scroll = view === "list" ? element : element.querySelector(".overflow-auto");
          if (!(scroll instanceof HTMLElement)) throw Error("Missing scroll container");
          scroll.scrollTop = scroll.scrollHeight;
        }, mode);
        const last = region.locator('[data-path="/flat-10k/09999.bin"]');
        await last.waitFor({ state: "visible" });
        await last.click({ noWaitAfter: true });
        await page.waitForFunction(
          () =>
            document
              .querySelector('[data-path="/flat-10k/09999.bin"]')
              ?.getAttribute("data-selected") === "true",
        );
        maxMounted = Math.max(maxMounted, await region.locator("[data-path]").count());
        await writeFile(
          output,
          JSON.stringify({
            progress: { mode, index, phase: "open", elapsed, layout },
            results,
            samplesMs,
            diagnostics,
          }),
        );
        diagnostics.push({
          layout,
          stats: await page.evaluate(
            () => (window as typeof window & { fdrivePerfStats?: BrowserStats }).fdrivePerfStats,
          ),
        });
        await page.keyboard.press("Enter");
        await page
          .waitForFunction(() => location.pathname === "/view/flat-10k/09999.bin")
          .catch(async () => {
            const state = await page.evaluate(() => ({
              path: location.pathname,
              focused: document.querySelector('[data-focused="true"]')?.getAttribute("data-path"),
              active: document.activeElement?.outerHTML.slice(0, 300),
            }));
            throw Error(`Selected file did not open: ${JSON.stringify(state)}`);
          });
        await page
          .locator('[data-slot="card-title"]')
          .filter({ hasText: "09999.bin" })
          .waitFor({ state: "visible" });
        samplesMs.push(elapsed);
        await writeFile(
          output,
          JSON.stringify({
            progress: { mode, index, phase: "complete", elapsed },
            results,
            samplesMs,
            diagnostics,
          }),
        );
      } finally {
        await context.close();
      }
    }
    results[mode === "list" ? "uiList" : "uiGrid"] = {
      samplesMs,
      maxMounted,
      verifiedCount: 10000,
      diagnostics,
    };
  }
  const layoutChecks = [];
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    const context = await browser.newContext({ viewport });
    try {
      const separator = cookie.indexOf("=");
      await context.addCookies([
        { name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: baseUrl },
      ]);
      const page = await context.newPage();
      await page.goto(`${baseUrl}/system/indexer`, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "Indexer", exact: true }).waitFor();
      await page.getByLabel("Scan interval (seconds)", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Save", exact: true }).waitFor();
      const layout = await page.locator('[data-slot="sidebar-inset"]').evaluate((element) => {
        element.scrollTop = element.scrollHeight;
        return {
          height: element.clientHeight,
          scrollHeight: element.scrollHeight,
          scrollTop: element.scrollTop,
          viewport: innerHeight,
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: innerWidth,
        };
      });
      if (
        layout.height > layout.viewport ||
        layout.scrollTop <= 0 ||
        layout.documentWidth > layout.viewportWidth
      )
        throw Error(`Settings viewport or scrolling failed: ${JSON.stringify(layout)}`);
      layoutChecks.push(layout);
    } finally {
      await context.close();
    }
  }
  await writeFile(output, JSON.stringify({ browser: browser.version(), results, layoutChecks }));
} finally {
  await browser.close();
}
