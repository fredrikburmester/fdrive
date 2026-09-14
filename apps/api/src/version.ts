import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Resolve once at startup: image metadata first, then a local checkout, then package version. */
export function readVersion(): string {
  let revision: string;
  try {
    revision = readFileSync(new URL("../build-revision", import.meta.url), "utf8").trim();
  } catch {
    try {
      revision = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1_000,
      }).trim();
    } catch {
      revision = "";
    }
  }
  if (/^[a-f0-9]{40,64}$/i.test(revision)) return revision;
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: string;
  };
  return pkg.version && pkg.version !== "0.0.0" ? pkg.version : "development";
}
