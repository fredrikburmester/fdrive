import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = join(import.meta.dirname, "..", "..", "deploy", "init-env.sh");

function fixture(): {
  envPath: string;
  environment: NodeJS.ProcessEnv;
  root: string;
  run: () => ReturnType<typeof spawnSync>;
  script: string;
} {
  const root = mkdtempSync(join(tmpdir(), "fdrive-init-env-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const script = join(root, "init-env.sh");
  copyFileSync(source, script);
  chmodSync(script, 0o755);
  const openssl = join(bin, "openssl");
  writeFileSync(openssl, "#!/bin/bash\nprintf 'generated-%s' \"$2\"\n");
  chmodSync(openssl, 0o755);
  const envPath = join(root, ".env");
  return {
    envPath,
    environment: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    root,
    run: () =>
      spawnSync("bash", [script, envPath], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      }),
    script,
  };
}

describe("init-env.sh", () => {
  it("creates a private secrets file without printing secrets", () => {
    const test = fixture();
    try {
      const result = test.run();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`created ${test.envPath}`);
      expect(result.stdout).not.toContain("generated-");
      expect(readFileSync(test.envPath, "utf8")).toContain("FDRIVE_MASTER_KEY=generated--base64");
      expect(statSync(test.envPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(test.root, { recursive: true, force: true });
    }
  });

  it("refuses an existing file and preserves its contents", () => {
    const test = fixture();
    try {
      writeFileSync(test.envPath, "FDRIVE_MASTER_KEY=keep\n");
      const before = readFileSync(test.envPath, "utf8");
      const result = test.run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("refusing to overwrite");
      expect(readFileSync(test.envPath, "utf8")).toBe(before);
    } finally {
      rmSync(test.root, { recursive: true, force: true });
    }
  });

  it("allows exactly one concurrent creator without rotating the winning secrets", async () => {
    const test = fixture();
    try {
      const runAsync = () =>
        new Promise<number | null>((resolve) => {
          const child = spawn("bash", [test.script, test.envPath], { env: test.environment });
          child.on("close", resolve);
        });
      const statuses = await Promise.all([runAsync(), runAsync()]);
      expect(statuses.sort()).toEqual([0, 1]);
      const generated = readFileSync(test.envPath, "utf8");
      expect(generated).toContain("FDRIVE_MASTER_KEY=generated--base64");
      expect(generated).toContain("POSTGRES_PASSWORD=generated--hex");
      expect(statSync(test.envPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(test.root, { recursive: true, force: true });
    }
  });
});
