// Run with the API container's Node runtime; the worker credential stays inside
// that container. No host Node/Python/jq installation is required.
import { setTimeout as delay } from "node:timers/promises";

const featureIds = [
  "thumbnails",
  "textSearch",
  "searchOcr",
  "semanticSearch",
  "imageSearch",
  "pdfOcr",
] as const;
type FeatureId = (typeof featureIds)[number];
type Features = { version: number; revision: number; values: Record<FeatureId, boolean> };
type Office = { version: number; enabled: boolean };
type Health = {
  service: string;
  status: string;
  subsystems: Record<string, { status: string; detail?: string; missing?: string[] }>;
};

export async function checkReadiness(
  fetchImpl: typeof fetch,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const base = `http://127.0.0.1:${env.PORT || "3001"}/api/v1`;
  const json = async <T>(path: string, authenticated = false): Promise<T> => {
    const response = await fetchImpl(path, {
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
      headers: authenticated ? { "x-fdrive-worker-token": env.FDRIVE_WORKER_TOKEN ?? "" } : {},
    });
    // Never print response bodies or request headers: internal endpoints carry credentials.
    if (!response.ok) throw new Error(`readiness endpoint returned HTTP ${response.status}`);
    return response.json() as Promise<T>;
  };
  const [features, office, health] = await Promise.all([
    json<Features>(`${base}/internal/features`, true),
    json<Office>(`${base}/internal/office`, true),
    json<Health>(`${base}/health`),
  ]);
  if (
    features?.version !== 1 ||
    !Number.isInteger(features.revision) ||
    featureIds.some((id) => typeof features.values?.[id] !== "boolean") ||
    office?.version !== 1 ||
    typeof office.enabled !== "boolean" ||
    health?.service !== "fdrive-api" ||
    health.status !== "ok" ||
    !health.subsystems
  )
    throw new Error("invalid readiness response");

  const values = features.values;
  const required = new Set(["core"]);
  if (
    values.thumbnails ||
    values.textSearch ||
    values.searchOcr ||
    values.semanticSearch ||
    values.imageSearch
  )
    required.add("index");
  if (values.thumbnails) required.add("thumbnails");
  if (values.semanticSearch) required.add("search");
  if (values.imageSearch) required.add("imageSearch");
  if (values.pdfOcr) required.add("ocr");
  if (office.enabled) required.add("office");
  const pending: string[] = [];
  for (const name of required) {
    const subsystem = health.subsystems[name];
    if (subsystem?.status !== "configured") {
      pending.push(
        `${name}: ${subsystem?.status ?? "missing"}${subsystem?.detail ? ` (${subsystem.detail})` : ""}`,
      );
    }
  }
  // Text extraction has a managed worker but no entry in the public health map.
  if (values.textSearch || values.searchOcr || values.semanticSearch) {
    try {
      const tika = await json<{ status: string; revision: number }>("http://tika:9997/runtime");
      if (tika?.status !== "ready") {
        pending.push(`text extraction: ${tika?.status ?? "missing"}`);
      } else if (tika.revision !== features.revision) {
        pending.push("text extraction: awaiting current configuration");
      }
    } catch {
      pending.push("text extraction: endpoint unavailable");
    }
  }
  return pending;
}

export async function waitForReadiness({
  fetchImpl = fetch,
  env = process.env,
  now = Date.now,
  sleep = (ms: number) => delay(ms),
  log = console.log,
} = {}): Promise<void> {
  const seconds = Number(env.FDRIVE_READY_TIMEOUT_SECONDS ?? "1200");
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error("FDRIVE_READY_TIMEOUT_SECONDS must be a positive integer");
  }
  const deadline = now() + seconds * 1000;
  let last = "";
  while (true) {
    let pending: string;
    try {
      const problems = await checkReadiness(fetchImpl, env);
      if (problems.length === 0) {
        log("Enabled subsystems ready.");
        return;
      }
      pending = problems.join("; ");
    } catch (error) {
      // Fetch exceptions may include URLs; print only our fixed diagnostic messages.
      pending =
        error instanceof Error &&
        /^(readiness endpoint returned HTTP \d+|invalid readiness response)$/.test(error.message)
          ? error.message
          : "readiness endpoint unavailable";
    }
    if (pending !== last) log(`Waiting: ${pending}`);
    last = pending;
    if (now() >= deadline) throw new Error(`Readiness timed out after ${seconds}s: ${pending}`);
    await sleep(Math.min(5000, deadline - now()));
  }
}

// update.sh streams this file to Node's stdin; imports in tests do not run it.
if (process.argv[1] === undefined) {
  await waitForReadiness().catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
