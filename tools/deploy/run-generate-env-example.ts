/**
 * CLI entrypoint for `pnpm env:example`: writes `deploy/.env.example` and
 * refreshes the generated passthrough block inside `deploy/compose.yaml`.
 * All rendering logic lives in `generate-env-example.ts`, which has no file
 * I/O of its own and is fully unit tested; this script is the only thing
 * that touches the filesystem, and is excluded from the coverage gate the
 * same way `apps/api/src/main.ts` is (see `vitest.config.ts`).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyComposePassthroughBlock,
  applyPreflightKnownKeysBlock,
  knownFdriveKeys,
  renderComposePassthroughLines,
  renderEnvExample,
  renderKnownFdriveKeysBashArray,
} from "./generate-env-example.ts";

function main(): void {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const deployDir = join(scriptDir, "..", "..", "deploy");
  const envExamplePath = join(deployDir, ".env.example");
  const composePath = join(deployDir, "compose.yaml");
  const preflightPath = join(deployDir, "preflight.sh");

  writeFileSync(envExamplePath, renderEnvExample(), "utf-8");
  console.log(`Wrote ${envExamplePath}`);

  const composeSource = readFileSync(composePath, "utf-8");
  const updatedCompose = applyComposePassthroughBlock(
    composeSource,
    renderComposePassthroughLines(),
  );
  writeFileSync(composePath, updatedCompose, "utf-8");
  console.log(`Updated the generated block in ${composePath}`);

  const preflightSource = readFileSync(preflightPath, "utf-8");
  const updatedPreflight = applyPreflightKnownKeysBlock(
    preflightSource,
    renderKnownFdriveKeysBashArray(knownFdriveKeys()),
  );
  writeFileSync(preflightPath, updatedPreflight, "utf-8");
  console.log(`Updated the generated block in ${preflightPath}`);
}

main();
