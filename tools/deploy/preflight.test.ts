import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const preflightPath = join(scriptDir, "..", "..", "deploy", "preflight.sh");

let workDir: string | undefined;

afterEach(() => {
  if (workDir !== undefined) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

/**
 * Runs `deploy/preflight.sh` against a fixture `.env` written into a fresh
 * temp directory (preflight.sh only ever reads the `.env` next to its own
 * path, so the script is copied alongside the fixture). Returns the exit
 * code and combined stdout/stderr rather than throwing, so tests can assert
 * on failure cases directly.
 */
function runPreflight(envContents: string | undefined): { code: number; output: string } {
  workDir = mkdtempSync(join(tmpdir(), "fdrive-preflight-"));
  const scriptCopyPath = join(workDir, "preflight.sh");
  writeFileSync(scriptCopyPath, execFileSync("cat", [preflightPath], { encoding: "utf-8" }), {
    mode: 0o755,
  });
  if (envContents !== undefined) {
    writeFileSync(join(workDir, ".env"), envContents, "utf-8");
  }
  try {
    const output = execFileSync("bash", [scriptCopyPath], {
      cwd: workDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output };
  } catch (error) {
    const err = error as { status: number | null; stdout: string; stderr: string };
    return { code: err.status ?? 1, output: `${err.stdout}${err.stderr}` };
  }
}

describe("deploy/preflight.sh", () => {
  it("fails when .env is missing", () => {
    const result = runPreflight(undefined);
    expect(result.code).toBe(1);
    expect(result.output).toContain(".env not found");
  });

  it("fails on a change-me placeholder", () => {
    const result = runPreflight(
      [
        "POSTGRES_PASSWORD=change-me",
        "FDRIVE_MASTER_KEY=abc",
        "FDRIVE_HOME_TEMPLATE=sftpgo:/{username}",
      ].join("\n"),
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain("change-me placeholder");
  });

  it("fails on an unknown FDRIVE_* key (a likely typo)", () => {
    const result = runPreflight(
      [
        "POSTGRES_PASSWORD=real",
        "FDRIVE_MASTER_KEY=abc",
        "FDRIVE_HOME_TEMPLATE=sftpgo:/{username}",
        "FDRIVE_TRUSTD_PROXY_HOPS=1",
      ].join("\n"),
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain("unknown key 'FDRIVE_TRUSTD_PROXY_HOPS'");
  });

  it("names keys that compose.yaml fixes itself instead of calling them typos", () => {
    const result = runPreflight(
      [
        "POSTGRES_PASSWORD=secret",
        "FDRIVE_MASTER_KEY=abc",
        'FDRIVE_INDEX_ROOTS=[{"name":"sftpgo"}]',
        "FDRIVE_INDEXER_URL=http://indexer:8010",
        "",
      ].join("\n"),
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain("'FDRIVE_INDEX_ROOTS' in");
    expect(result.output).toContain("is set by compose.yaml and has no effect here; remove it");
    expect(result.output).toContain("'FDRIVE_INDEXER_URL' in");
    expect(result.output).not.toContain("typo?");
  });

  it("accepts every documented FDRIVE_* key without flagging a typo", () => {
    const result = runPreflight(
      [
        "POSTGRES_PASSWORD=real",
        "FDRIVE_MASTER_KEY=abc",
        "FDRIVE_HOME_TEMPLATE=sftpgo:/{username}",
        "FDRIVE_TRUSTED_PROXY_HOPS=2",
        "FDRIVE_ADMIN_USERS=alice,bob",
      ].join("\n"),
    );
    expect(result.code).toBe(0);
    expect(result.output).not.toContain("unknown key");
  });

  it("ignores non-FDRIVE_ keys entirely, even unrecognized ones", () => {
    const result = runPreflight(
      [
        "POSTGRES_PASSWORD=real",
        "FDRIVE_MASTER_KEY=abc",
        "FDRIVE_HOME_TEMPLATE=sftpgo:/{username}",
        "SOME_OTHER_TOOLS_VARIABLE=1",
      ].join("\n"),
    );
    expect(result.code).toBe(0);
  });

  it("fails on a FDRIVE_HOME_TEMPLATE missing the {username} placeholder", () => {
    const result = runPreflight(
      [
        "POSTGRES_PASSWORD=real",
        "FDRIVE_MASTER_KEY=abc",
        "FDRIVE_HOME_TEMPLATE=sftpgo:/static",
      ].join("\n"),
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain("must look like <root>:<path with {username}>");
  });

  it("fails on a FDRIVE_HOME_TEMPLATE missing the root: prefix", () => {
    const result = runPreflight(
      ["POSTGRES_PASSWORD=real", "FDRIVE_MASTER_KEY=abc", "FDRIVE_HOME_TEMPLATE={username}"].join(
        "\n",
      ),
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain("must look like <root>:<path with {username}>");
  });

  it("allows FDRIVE_HOME_TEMPLATE to be left unset entirely", () => {
    const result = runPreflight(["POSTGRES_PASSWORD=real", "FDRIVE_MASTER_KEY=abc"].join("\n"));
    expect(result.code).toBe(0);
  });

  it("prints the resolved FDRIVE_INDEX_ROOTS default when FDRIVE_INDEX_SFTPGO_PATH is unset", () => {
    const result = runPreflight(["POSTGRES_PASSWORD=real", "FDRIVE_MASTER_KEY=abc"].join("\n"));
    expect(result.output).toContain('"sftpgoPath":"/srv/sftpgo/data"');
  });

  it("prints the resolved FDRIVE_INDEX_ROOTS using an overridden FDRIVE_INDEX_SFTPGO_PATH", () => {
    const result = runPreflight(
      ["POSTGRES_PASSWORD=real", "FDRIVE_MASTER_KEY=abc", "FDRIVE_INDEX_SFTPGO_PATH=/custom"].join(
        "\n",
      ),
    );
    expect(result.output).toContain('"sftpgoPath":"/custom"');
  });

  it("prints the default bind address and port when unset", () => {
    const result = runPreflight(["POSTGRES_PASSWORD=real", "FDRIVE_MASTER_KEY=abc"].join("\n"));
    expect(result.output).toContain("bind address: 0.0.0.0:8090");
  });

  it("prints an overridden bind address and port", () => {
    const result = runPreflight(
      [
        "POSTGRES_PASSWORD=real",
        "FDRIVE_MASTER_KEY=abc",
        "FDRIVE_HTTP_BIND=127.0.0.1",
        "FDRIVE_HTTP_PORT=9090",
      ].join("\n"),
    );
    expect(result.output).toContain("bind address: 127.0.0.1:9090");
  });

  it("accepts HTTPS edge configuration", () => {
    expect(
      runPreflight("POSTGRES_PASSWORD=real\nFDRIVE_MASTER_KEY=abc\nFDRIVE_PROXY_SCHEME=https").code,
    ).toBe(0);
  });

  it("rejects an invalid proxy scheme", () => {
    const result = runPreflight(
      "POSTGRES_PASSWORD=real\nFDRIVE_MASTER_KEY=abc\nFDRIVE_PROXY_SCHEME=ftp",
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain("FDRIVE_PROXY_SCHEME must be http or https");
  });

  it("fails when FDRIVE_PUBLIC_URL is https but FDRIVE_PROXY_SCHEME is left at its http default", () => {
    const result = runPreflight(
      [
        "POSTGRES_PASSWORD=real",
        "FDRIVE_MASTER_KEY=abc",
        "FDRIVE_PUBLIC_URL=https://drive.example.com",
      ].join("\n"),
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "FDRIVE_PUBLIC_URL is https:// but FDRIVE_PROXY_SCHEME is http",
    );
    expect(result.output).toContain("set FDRIVE_PROXY_SCHEME=https");
    expect(result.output).toContain("Download failed");
  });

  it("fails when FDRIVE_PUBLIC_URL is https but FDRIVE_PROXY_SCHEME is explicitly http", () => {
    const result = runPreflight(
      [
        "POSTGRES_PASSWORD=real",
        "FDRIVE_MASTER_KEY=abc",
        'FDRIVE_PUBLIC_URL="https://drive.example.com"',
        "FDRIVE_PROXY_SCHEME=http",
      ].join("\n"),
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain("set FDRIVE_PROXY_SCHEME=https");
  });

  it("fails when FDRIVE_PUBLIC_URL is http but FDRIVE_PROXY_SCHEME is https", () => {
    const result = runPreflight(
      [
        "POSTGRES_PASSWORD=real",
        "FDRIVE_MASTER_KEY=abc",
        "FDRIVE_PUBLIC_URL=http://192.168.1.10:8090",
        "FDRIVE_PROXY_SCHEME=https",
      ].join("\n"),
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "FDRIVE_PUBLIC_URL is http:// but FDRIVE_PROXY_SCHEME is https",
    );
    expect(result.output).toContain("set FDRIVE_PROXY_SCHEME=http");
  });

  it("accepts FDRIVE_PUBLIC_URL and FDRIVE_PROXY_SCHEME that agree on https", () => {
    const result = runPreflight(
      [
        "POSTGRES_PASSWORD=real",
        "FDRIVE_MASTER_KEY=abc",
        "FDRIVE_PUBLIC_URL=https://drive.example.com",
        "FDRIVE_PROXY_SCHEME=https",
      ].join("\n"),
    );
    expect(result.code).toBe(0);
    expect(result.output).toContain("preflight OK");
  });

  it("accepts an http FDRIVE_PUBLIC_URL with the default proxy scheme", () => {
    const result = runPreflight(
      [
        "POSTGRES_PASSWORD=real",
        "FDRIVE_MASTER_KEY=abc",
        "FDRIVE_PUBLIC_URL=http://192.168.1.10:8090",
      ].join("\n"),
    );
    expect(result.code).toBe(0);
  });

  it("leaves a FDRIVE_PUBLIC_URL without a recognised scheme to the api's own validation", () => {
    const result = runPreflight(
      [
        "POSTGRES_PASSWORD=real",
        "FDRIVE_MASTER_KEY=abc",
        "FDRIVE_PUBLIC_URL=drive.example.com",
        "FDRIVE_PROXY_SCHEME=https",
      ].join("\n"),
    );
    expect(result.code).toBe(0);
  });

  it("reports every failure together (both change-me and an unknown key) before exiting", () => {
    const result = runPreflight(
      ["POSTGRES_PASSWORD=change-me", "FDRIVE_MASTER_KEY=abc", "FDRIVE_TRUSTD_PROXY_HOPS=1"].join(
        "\n",
      ),
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain("change-me placeholder");
    expect(result.output).toContain("unknown key 'FDRIVE_TRUSTD_PROXY_HOPS'");
  });

  it("succeeds and prints preflight OK on a fully valid .env", () => {
    const result = runPreflight(
      [
        "POSTGRES_PASSWORD=real",
        "FDRIVE_MASTER_KEY=abc",
        "FDRIVE_HOME_TEMPLATE=sftpgo:/{username}",
      ].join("\n"),
    );
    expect(result.code).toBe(0);
    expect(result.output).toContain("preflight OK");
  });
});
