import { execFile, spawn } from "node:child_process";

export function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { ...options, timeout: options.timeout ?? 120_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`${command} failed: ${stderr.slice(-4000)}`));
        else resolve(stdout);
      },
    );
  });
}

export function runWithInput(
  command: string,
  args: readonly string[],
  input: string,
  timeoutMs = 60_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (bytes: Buffer) => {
      stderr = `${stderr}${bytes.toString()}`.slice(-4000);
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.stdin.on("error", () => {
      /* Exit handles a closed input pipe. */
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`${command} failed: ${stderr.slice(-2000)}`));
    });
    child.stdin.end(input);
  });
}
