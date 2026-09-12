import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function run(settings = "", readinessExit = 0) {
  const root = mkdtempSync(join(tmpdir(), "fdrive-update-test-"));
  const deploy = join(root, "deploy");
  const bin = join(root, "bin");
  mkdirSync(deploy);
  mkdirSync(bin);
  copyFileSync(join(import.meta.dirname, "../../deploy/update.sh"), join(deploy, "update.sh"));
  copyFileSync(
    join(import.meta.dirname, "../../deploy/wait-ready.ts"),
    join(deploy, "wait-ready.ts"),
  );
  writeFileSync(join(deploy, ".env"), settings);
  writeFileSync(join(deploy, "preflight.sh"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  for (const command of ["git", "docker", "curl"]) {
    writeFileSync(
      join(bin, command),
      `#!/bin/bash\nprintf '%s\\n' "${command} $*"\nif [[ "$*" == *"--input-type=module-typescript"* ]]; then exit ${readinessExit}; fi\n`,
      {
        mode: 0o755,
      },
    );
  }
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  for (const key of Object.keys(env)) {
    if (key.startsWith("FDRIVE_")) delete env[key];
  }
  try {
    const result = spawnSync("bash", [join(deploy, "update.sh")], { env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(readinessExit);
    return result.stdout;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("update startup addresses", () => {
  it("runs readiness with the selected overlays and timeout before reporting success", () => {
    const output = run(
      "FDRIVE_READY_TIMEOUT_SECONDS=1800\nFDRIVE_COMPOSE_FILES=compose.example.yaml\n",
    );
    expect(output).toContain(
      "docker compose -f compose.yaml -f compose.example.yaml exec -T -e FDRIVE_READY_TIMEOUT_SECONDS=1800 api node --input-type=module-typescript",
    );
    expect(output.indexOf("--input-type=module-typescript")).toBeLessThan(
      output.indexOf("curl -sf"),
    );
  });

  it("fails the update when readiness fails", () => {
    const output = run("", 1);
    expect(output).toContain("waiting for enabled subsystems");
    expect(output).not.toContain("curl -sf");
    expect(output).not.toContain("to complete setup");
  });

  it("directs a default installation to the server IP from another device", () => {
    const output = run();
    expect(output).toContain("curl -sf --max-time 10 http://127.0.0.1:8090/api/v1/health");
    expect(output).toContain("From another device on your network, open http://<server-ip>:8090");
  });

  it("honors explicit local-only binding and the port in .env", () => {
    const output = run("FDRIVE_HTTP_BIND=127.0.0.1\nFDRIVE_HTTP_PORT=9090\n");
    expect(output).toContain("http://127.0.0.1:9090/api/v1/health");
    expect(output).toContain("Open http://127.0.0.1:9090 in your browser");
  });

  it("checks a specific server binding and prints that address", () => {
    const output = run("FDRIVE_HTTP_BIND=192.0.2.5\nFDRIVE_HTTP_PORT=9090\n");
    expect(output).toContain("http://192.0.2.5:9090/api/v1/health");
    expect(output).toContain("Open http://192.0.2.5:9090 in your browser");
  });
});
