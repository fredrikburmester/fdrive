import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBrowserOutput } from "./browser-output.js";
import { createCleanup } from "./lifecycle.js";
import { type ScenarioResult, toScenarioResult } from "./results.js";
import { child, command, ready } from "./runtime.js";
import type { PerfStack } from "./stack.js";

export async function runBrowser(stack: PerfStack): Promise<{
  uiList: ScenarioResult;
  uiGrid: ScenarioResult;
  browserVersion: string;
  layoutChecks: unknown;
}> {
  const cleanup = createCleanup();
  try {
    const dir = await mkdtemp(join(tmpdir(), "fdrive-perf-ui-"));
    cleanup.add(() => rm(dir, { recursive: true, force: true }));
    const output = join(dir, "results.json");
    const env = {
      ...process.env,
      API_INTERNAL_URL: stack.apiBaseUrl,
      NEXT_TELEMETRY_DISABLED: "1",
    };
    console.log("[perf] building isolated production Next application");
    await command("pnpm", ["--filter", "@fdrive/web...", "run", "build"], {
      cwd: stack.rootDir,
      env,
    });
    const port = await command(process.execPath, [
      "-e",
      "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})",
    ]);
    const webUrl = `http://127.0.0.1:${port}`;
    child(
      cleanup,
      "pnpm",
      [
        "--filter",
        "@fdrive/web",
        "exec",
        "next",
        "start",
        "--port",
        port,
        "--hostname",
        "127.0.0.1",
      ],
      stack.rootDir,
      env,
    );
    await ready(`${webUrl}/login`);
    try {
      await command("pnpm", ["exec", "tsx", "apps/web/perf/run.ts"], {
        cwd: stack.rootDir,
        env: { ...env, PERF_WEB_URL: webUrl, PERF_COOKIE: stack.cookie, PERF_UI_OUTPUT: output },
      });
    } catch (error) {
      const progress = await readFile(output, "utf8").catch(() => "unavailable");
      throw Error(
        `${error instanceof Error ? error.message : "Browser failed"}; partial observations: ${progress.slice(-5000)}`,
      );
    }
    const raw = parseBrowserOutput(JSON.parse(await readFile(output, "utf8")));
    function result(name: string): ScenarioResult {
      const value = raw.results[name];
      if (!value) throw Error("Browser scenario missing");
      return toScenarioResult(
        name,
        value.samplesMs,
        (value.samplesMs.length * 1000) / value.samplesMs.reduce((a, b) => a + b, 0),
        0,
        {
          maxMounted: value.maxMounted,
          verifiedCount: value.verifiedCount,
          diagnostics: value.diagnostics,
        },
      );
    }
    return {
      uiList: result("uiList"),
      uiGrid: result("uiGrid"),
      browserVersion: raw.browser,
      layoutChecks: raw.layoutChecks,
    };
  } finally {
    await cleanup.close();
  }
}
