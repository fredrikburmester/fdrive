import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** What the running API was built from, resolved once at startup by `readBuild`. */
export interface Build {
  /** Full Git commit, or null when unknown. */
  readonly revision: string | null;
  /** Release the image was built as: `X.Y.Z` from a `vX.Y.Z` tag, or `main`; null otherwise. */
  readonly release: string | null;
  /** One value for `/health` and older clients: the revision, else the release, else `development`. */
  readonly version: string;
}

/** A metadata file the image build writes next to package.json, or null outside an image. */
function readBuildFile(name: string): string | null {
  try {
    return readFileSync(new URL(`../${name}`, import.meta.url), "utf8").trim();
  } catch {
    return null;
  }
}

function checkoutRevision(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    }).trim();
  } catch {
    return "";
  }
}

/**
 * The images workflow builds `X.Y.Z` for a release tag, `main` for the main branch and `dev`
 * for anything else. Only a release or `main` names what is running, so `dev`, an empty
 * value and `latest` count as no release.
 */
function parseRelease(value: string): string | null {
  if (value === "main") return value;
  return /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(value)?.[1] ?? null;
}

/** Image metadata first, then a local checkout's commit; a release only comes from an image. */
export function readBuild(): Build {
  // An image always has the file, so host Git never describes an image built without a commit.
  const commit = readBuildFile("build-revision") ?? checkoutRevision();
  const revision = /^[a-f0-9]{40,64}$/i.test(commit) ? commit : null;
  const release = parseRelease(readBuildFile("build-version") ?? "");
  return { revision, release, version: revision ?? release ?? "development" };
}
