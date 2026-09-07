import { expect, it, vi } from "vitest";
import { createCleanup } from "./lifecycle.js";
import { child, command, container, ready, signalGroup } from "./runtime.js";

it("runs commands and redacts connection strings in failure output", async () => {
  expect(await command(process.execPath, ["-e", "console.log('done')"])).toBe("done");
  await expect(
    command(process.execPath, [
      "-e",
      "process.stderr.write('postgresql://user:password@host/db');process.exit(1)",
    ]),
  ).rejects.toThrow("[database URL]");
  await expect(command("fdrive-perf-no-such-command", [])).rejects.toThrow("ENOENT");
});
it("registers container cleanup before start and retains it after start/port failures", async () => {
  for (const fail of ["none", "start", "port"]) {
    const cleanup = createCleanup();
    const calls: string[][] = [];
    const run: typeof command = async (_program, args) => {
      calls.push(args);
      if (args[0] === "start" && fail === "start") throw Error("start failed");
      if (args[0] === "port") return fail === "port" ? "invalid" : "127.0.0.1:12345";
      return "fixture-id";
    };
    const started = container(cleanup, ["image"], 8080, run);
    if (fail === "none") expect(await started).toBe("http://127.0.0.1:12345");
    else await expect(started).rejects.toThrow();
    await cleanup.close();
    expect(calls[0]?.[0]).toBe("create");
    expect(calls.at(-1)).toEqual(["rm", "--force", "fixture-id"]);
  }
});
it("waits for real readiness and fails closed on unavailable services", async () => {
  await ready("http://fixture", 100, async () => new Response(null));
  await expect(
    ready("http://fixture", 1, async () => {
      throw Error("offline");
    }),
  ).rejects.toThrow("timed out");
  await expect(
    ready("http://fixture", 1, async () => new Response("down", { status: 503 })),
  ).rejects.toThrow("timed out");
});
it("closes child process groups and reports spawn failures", async () => {
  const cleanup = createCleanup();
  const worker = child(
    cleanup,
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    process.cwd(),
    process.env,
  );
  await new Promise<void>((resolve) => worker.once("spawn", () => resolve()));
  await cleanup.close();
  expect(worker.signalCode).toBe("SIGTERM");
  const bad = createCleanup();
  const failed = child(bad, "fdrive-perf-no-such-command", [], process.cwd(), process.env);
  await new Promise<void>((resolve) => failed.once("error", () => resolve()));
  await expect(bad.close()).rejects.toThrow(AggregateError);
});

it("only suppresses an already gone process group", () => {
  const gone = Object.assign(new Error("gone"), { code: "ESRCH" });
  const denied = Object.assign(new Error("denied"), { code: "EPERM" });
  expect(
    signalGroup(123, "SIGTERM", () => {
      throw gone;
    }),
  ).toBe(false);
  expect(() =>
    signalGroup(123, "SIGTERM", () => {
      throw denied;
    }),
  ).toThrow("denied");
});
it("cleans a child that already exited by signal", async () => {
  const cleanup = createCleanup();
  const worker = child(
    cleanup,
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    process.cwd(),
    process.env,
  );
  await new Promise<void>((resolve) => worker.once("spawn", () => resolve()));
  const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
  worker.kill("SIGTERM");
  await exited;
  expect(worker.exitCode).toBeNull();
  expect(worker.signalCode).toBe("SIGTERM");
  await cleanup.close();
});
it("handles a group disappearing between exit checks and TERM or KILL", async () => {
  for (const when of ["term", "kill", "kill-error"]) {
    const cleanup = createCleanup();
    const calls: NodeJS.Signals[] = [];
    const worker = child(
      cleanup,
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      process.cwd(),
      process.env,
      (_pid, signal) => {
        calls.push(signal);
        if (signal === "SIGTERM") return when !== "term";
        if (when === "kill-error") throw Error("permission denied");
        return false;
      },
    );
    await new Promise<void>((resolve) => worker.once("spawn", () => resolve()));
    vi.useFakeTimers();
    try {
      const closing = cleanup.close();
      const assertion =
        when === "kill-error"
          ? expect(closing).rejects.toThrow(AggregateError)
          : expect(closing).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(10000);
      await assertion;
      expect(calls).toEqual(when === "term" ? ["SIGTERM"] : ["SIGTERM", "SIGKILL"]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
      worker.kill("SIGTERM");
      await exited;
    }
  }
});

it("populates stopped containers before startup and cleans preparation failures", async () => {
  for (const fails of [false, true]) {
    const cleanup = createCleanup();
    const calls: string[] = [];
    const run: typeof command = async (_program, args) => {
      calls.push(args[0] ?? "missing");
      return args[0] === "port" ? "127.0.0.1:1234" : "fixture";
    };
    const pending = container(cleanup, ["image"], 8080, run, async (id) => {
      expect(id).toBe("fixture");
      calls.push("populate");
      if (fails) throw Error("copy failed");
    });
    if (fails) await expect(pending).rejects.toThrow("copy failed");
    else await expect(pending).resolves.toBe("http://127.0.0.1:1234");
    await cleanup.close();
    expect(calls).toEqual(
      fails ? ["create", "populate", "rm"] : ["create", "populate", "start", "port", "rm"],
    );
  }
});
