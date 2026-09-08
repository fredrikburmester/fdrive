import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function run(settings = "") {
  const root = mkdtempSync(join(tmpdir(), "fdrive-update-test-"));
  const deploy = join(root, "deploy");
  const bin = join(root, "bin");
  mkdirSync(deploy);
  mkdirSync(bin);
  copyFileSync(join(import.meta.dirname, "../../deploy/update.sh"), join(deploy, "update.sh"));
  writeFileSync(join(deploy, ".env"), settings);
  writeFileSync(join(deploy, "preflight.sh"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  for (const command of ["git", "docker", "curl"]) {
    writeFileSync(join(bin, command), `#!/bin/bash\nprintf '%s\\n' "${command} $*"\n`, {
      mode: 0o755,
    });
  }
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  for (const key of Object.keys(env)) {
    if (key.startsWith("FDRIVE_")) delete env[key];
  }
  try {
    const result = spawnSync("bash", [join(deploy, "update.sh")], { env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("update startup addresses", () => {
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

  it("checks a specific server binding and prints the configured HTTPS address", () => {
    const output = run(
      'FDRIVE_HTTP_BIND=192.0.2.5\nFDRIVE_HTTP_PORT=9090\nFDRIVE_PUBLIC_URL="https://drive.example.com"\n',
    );
    expect(output).toContain("http://192.0.2.5:9090/api/v1/health");
    expect(output).toContain("Open https://drive.example.com in your browser");
  });
});
