import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface Scenario {
  /** deploy/.env contents. */
  readonly settings?: string;
  /** Release tags the stub git knows, in git's version order. */
  readonly tags?: readonly string[];
  readonly readinessExit?: number;
  readonly pullFails?: boolean;
  /** Variables the operator exported before running update.sh. */
  readonly environment?: Readonly<Record<string, string>>;
}

// Stand-ins for git, docker and curl: each prints its own command line, git
// answers the few queries update.sh makes, and docker shows the environment the
// compose file is interpolated with.
const GIT = `#!/bin/bash
case "$*" in
  "rev-parse HEAD") echo 0123456789abcdef0123456789abcdef01234567; exit 0 ;;
  "tag --list v* --sort=v:refname") printf '%s' "$FAKE_TAGS"; exit 0 ;;
  "rev-parse --quiet --verify refs/tags/"*)
    grep -qxF "\${4#refs/tags/}" <<< "$FAKE_TAGS" && exit 0 || exit 1 ;;
esac
echo "git $*"
`;
const DOCKER = `#!/bin/bash
echo "build revision: $FDRIVE_BUILD_REVISION"
echo "image version: $FDRIVE_VERSION"
echo "docker $*"
if [[ "$*" == *" pull "* && -n "$FAKE_PULL_FAILS" ]]; then exit 1; fi
if [[ "$*" == *"--input-type=module-typescript"* ]]; then exit "$FAKE_READINESS_EXIT"; fi
`;
const CURL = `#!/bin/bash
echo "curl $*"
`;

function run({
  settings = "",
  tags = ["v0.1.0", "v0.2.0"],
  readinessExit = 0,
  pullFails = false,
  environment = {},
}: Scenario = {}) {
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
  writeFileSync(join(deploy, "build-arm64-runtime.sh"), "#!/bin/bash\necho arm64 base\n", {
    mode: 0o755,
  });
  for (const [command, source] of [
    ["git", GIT],
    ["docker", DOCKER],
    ["curl", CURL],
  ] as const) {
    writeFileSync(join(bin, command), source, { mode: 0o755 });
  }
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  for (const key of Object.keys(env)) {
    if (key.startsWith("FDRIVE_")) delete env[key];
  }
  env.FAKE_TAGS = tags.map((tag) => `${tag}\n`).join("");
  env.FAKE_READINESS_EXIT = String(readinessExit);
  env.FAKE_PULL_FAILS = pullFails ? "1" : "";
  Object.assign(env, environment);
  try {
    const result = spawnSync("bash", [join(deploy, "update.sh")], { env, encoding: "utf8" });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function succeed(scenario: Scenario = {}) {
  const result = run(scenario);
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

describe("update release selection", () => {
  it("follows the newest release by default and pulls its images", () => {
    const output = succeed({ tags: ["v0.1.0", "v0.2.0", "v0.10.0", "v0.11.0-rc.1"] });
    expect(output).toContain("git fetch --quiet --force --tags origin");
    expect(output).toContain("git checkout --quiet --detach v0.10.0");
    expect(output).toContain("==> images for fdrive 0.10.0");
    expect(output).toContain("image version: 0.10.0");
    expect(output).not.toContain("image version: latest");
  });

  it("treats latest the same as an unset version", () => {
    const output = succeed({ settings: "FDRIVE_VERSION=latest\n" });
    expect(output).toContain("git checkout --quiet --detach v0.2.0");
    expect(output).toContain("image version: 0.2.0");
  });

  it("runs a pinned release, spelled with or without its v", () => {
    for (const pinned of ["0.1.0", "v0.1.0"]) {
      const output = succeed({ settings: `FDRIVE_VERSION=${pinned}\n` });
      expect(output).toContain("git checkout --quiet --detach v0.1.0");
      expect(output).toContain("image version: 0.1.0");
    }
  });

  it("refuses a version that was never released", () => {
    const result = run({ settings: "FDRIVE_VERSION=0.9.9\n" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("FDRIVE_VERSION=0.9.9 is not a release");
    expect(result.stdout).not.toContain("git checkout");
  });

  it("points at the main branch while nothing is released", () => {
    const result = run({ tags: ["v0.3.0-rc.1"] });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("set FDRIVE_VERSION=main");
    expect(result.stdout).not.toContain("git checkout");
  });

  it("follows the main branch and its edge images", () => {
    const output = succeed({ settings: "FDRIVE_VERSION=main\n" });
    expect(output).toContain("git fetch --quiet origin main");
    expect(output).toContain("git checkout --quiet main");
    expect(output).toContain("git merge --quiet --ff-only origin/main");
    expect(output).not.toContain("--tags");
    expect(output).toContain("image version: main");
  });

  it("prefers a version from the environment over deploy/.env", () => {
    const output = succeed({
      settings: "FDRIVE_VERSION=main\n",
      environment: { FDRIVE_VERSION: "0.1.0" },
    });
    expect(output).toContain("git checkout --quiet --detach v0.1.0");
    expect(output).toContain("image version: 0.1.0");
  });
});

describe("update images", () => {
  it("pulls the published images before starting the stack", () => {
    const output = succeed();
    const pull = output.indexOf("docker compose -f compose.yaml pull --ignore-buildable");
    const up = output.indexOf("docker compose -f compose.yaml up -d --build --remove-orphans");
    expect(pull).toBeGreaterThan(-1);
    expect(up).toBeGreaterThan(pull);
  });

  it("leaves the running containers alone when the images cannot be pulled", () => {
    const result = run({ pullFails: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not pull the fdrive 0.2.0 images");
    expect(result.stdout).not.toContain(" up -d");
  });

  it("passes the checked-out revision to source builds instead of a stale .env value", () => {
    const output = succeed({ settings: "FDRIVE_BUILD_REVISION=stale\n" });
    expect(output).toContain("build revision: 0123456789abcdef0123456789abcdef01234567");
    expect(output).not.toContain("build revision: stale");
  });

  it("builds the native TEI base only when the ARM64 source overlay is selected", () => {
    expect(succeed()).not.toContain("arm64 base");
    const output = succeed({
      settings: "FDRIVE_COMPOSE_FILES=compose.build.yaml compose.arm64.yaml\n",
    });
    expect(output).toContain("arm64 base");
    expect(output).toContain(
      "docker compose -f compose.yaml -f compose.build.yaml -f compose.arm64.yaml pull --ignore-buildable",
    );
  });
});

describe("update startup addresses", () => {
  it("runs readiness with the selected overlays and timeout before reporting success", () => {
    const output = succeed({
      settings: "FDRIVE_READY_TIMEOUT_SECONDS=1800\nFDRIVE_COMPOSE_FILES=compose.example.yaml\n",
    });
    expect(output).toContain(
      "docker compose -f compose.yaml -f compose.example.yaml exec -T -e FDRIVE_READY_TIMEOUT_SECONDS=1800 api node --input-type=module-typescript",
    );
    expect(output.indexOf("--input-type=module-typescript")).toBeLessThan(
      output.indexOf("curl -sf"),
    );
  });

  it("fails the update when readiness fails", () => {
    const result = run({ readinessExit: 1 });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("waiting for enabled subsystems");
    expect(result.stdout).not.toContain("curl -sf");
    expect(result.stdout).not.toContain("to complete setup");
  });

  it("directs a default installation to the server IP from another device", () => {
    const output = succeed();
    expect(output).toContain("curl -sf --max-time 10 http://127.0.0.1:8090/api/v1/health");
    expect(output).toContain("From another device on your network, open http://<server-ip>:8090");
  });

  it("honors explicit local-only binding and the port in .env", () => {
    const output = succeed({ settings: "FDRIVE_HTTP_BIND=127.0.0.1\nFDRIVE_HTTP_PORT=9090\n" });
    expect(output).toContain("http://127.0.0.1:9090/api/v1/health");
    expect(output).toContain("Open http://127.0.0.1:9090 in your browser");
  });

  it("checks a specific server binding and prints that address", () => {
    const output = succeed({ settings: "FDRIVE_HTTP_BIND=192.0.2.5\nFDRIVE_HTTP_PORT=9090\n" });
    expect(output).toContain("http://192.0.2.5:9090/api/v1/health");
    expect(output).toContain("Open http://192.0.2.5:9090 in your browser");
  });
});
