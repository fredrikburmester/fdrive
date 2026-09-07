import { type ChildProcess, execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { createCleanup } from "./lifecycle.js";

const execute = promisify(execFile);
export async function command(
  program: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  try {
    const result = await execute(program, args, { ...options, maxBuffer: 16 * 1024 * 1024 });
    return result.stdout.trim();
  } catch (error) {
    const details = error as { code?: unknown; stderr?: unknown };
    const stderr =
      typeof details.stderr === "string"
        ? details.stderr.replace(/postgres(?:ql)?:\/\/\S+/g, "[database URL]").slice(-4000)
        : "";
    throw Error(`${program} exited ${String(details.code)}: ${stderr}`);
  }
}
export async function container(
  cleanup: ReturnType<typeof createCleanup>,
  args: string[],
  port: number,
  run: typeof command = command,
  prepare?: (id: string) => Promise<void>,
): Promise<string> {
  const id = await run("docker", [
    "create",
    "--publish",
    `127.0.0.1::${port}`,
    "--add-host",
    "host.docker.internal:host-gateway",
    ...args,
  ]);
  cleanup.add(async () => {
    await run("docker", ["rm", "--force", id]);
  });
  await prepare?.(id);
  await run("docker", ["start", id]);
  const mapped = await run("docker", ["port", id, String(port)]);
  const match = /:(\d+)$/.exec(mapped);
  if (!match) throw Error("Container did not publish its port");
  return `http://127.0.0.1:${match[1]}`;
}
export async function ready(
  url: string,
  timeoutMs = 120000,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(2000) });
      await response.body?.cancel();
      if (response.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw Error("Fixture readiness timed out");
}
/** ESRCH means the group already exited. All other signal failures remain errors. */
export function signalGroup(
  pid: number,
  signal: NodeJS.Signals,
  kill: typeof process.kill = process.kill,
): boolean {
  try {
    kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
export function child(
  cleanup: ReturnType<typeof createCleanup>,
  program: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: typeof signalGroup = signalGroup,
): ChildProcess {
  const worker = spawn(program, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let failure: Error | undefined;
  worker.on("error", (error) => {
    failure = error;
  });
  worker.stderr?.resume();
  cleanup.add(async () => {
    if (failure) throw failure;
    const pid = worker.pid;
    if (pid === undefined) throw Error("Child process did not start");
    if (worker.exitCode !== null || worker.signalCode !== null) {
      // A wrapper may have exited while its descendants remain in the group.
      signal(pid, "SIGTERM");
      return;
    }
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      function finish(error?: Error) {
        clearTimeout(timer);
        worker.removeListener("exit", onExit);
        worker.removeListener("error", onError);
        if (error) reject(error);
        else resolve();
      }
      function onExit() {
        finish();
      }
      function onError(error: Error) {
        finish(error);
      }
      worker.once("exit", onExit);
      worker.once("error", onError);
      try {
        if (!signal(pid, "SIGTERM")) {
          finish();
          return;
        }
        timer = setTimeout(() => {
          try {
            if (!signal(pid, "SIGKILL")) finish();
          } catch (error) {
            finish(error as Error);
          }
        }, 10000);
        timer.unref();
      } catch (error) {
        finish(error as Error);
      }
    });
  });
  return worker;
}
