/**
 * Pure rendering for `deploy/.env.example` and `deploy/compose.yaml`'s
 * generated passthrough block, built from the single source of truth
 * (`apps/api/src/config-keys.ts`'s `CONFIG_KEYS` plus this directory's
 * `DEPLOY_EXTRA_KEYS`). `run-generate-env-example.ts` is the CLI entrypoint
 * (`pnpm env:example`) that actually writes the files; this module has no
 * file I/O of its own so `generate-env-example.test.ts` can cover it fully
 * and its diff test can regenerate both outputs into memory. The sandbox
 * this repository is sometimes edited under denies direct file access to
 * `.env*` files through editor tools, which is exactly why the write lives
 * in a separate script run as a subprocess rather than through an editor
 * tool call.
 */

import type { ConfigKeyDef, Subsystem } from "../../apps/api/src/config-keys.ts";
import { CONFIG_KEYS } from "../../apps/api/src/config-keys.ts";
import { DEPLOY_EXTRA_KEYS } from "./deploy-keys.ts";

/** Subsystem section order, matching `apps/api/src/config-keys.ts`'s `SUBSYSTEMS`. */
const SUBSYSTEMS: readonly Subsystem[] = [
  "core",
  "network",
  "index",
  "search",
  "imageSearch",
  "thumbnails",
  "ocr",
  "office",
  "trash",
  "shares",
];

const SUBSYSTEM_TITLES: Record<Subsystem, string> = {
  core: "Core",
  network: "Network and sessions",
  index: "Indexer",
  search: "Search",
  imageSearch: "Image search",
  thumbnails: "Thumbnails",
  ocr: "OCR",
  office: "Office editing",
  trash: "Trash",
  shares: "Shares",
};

/**
 * Environment variable keys `deploy/compose.yaml`'s `api` service already
 * sets explicitly, outside the generated passthrough block: secrets
 * (`DATABASE_URL`, `FDRIVE_MASTER_KEY`), a value fixed by the compose
 * topology (`PORT`, `SFTPGO_URL`, `FDRIVE_THUMBS_DIR`, `FDRIVE_OCR_URL`,
 * `FDRIVE_INDEXER_URL`, `FDRIVE_EMBED_URL`), the computed
 * `FDRIVE_INDEX_ROOTS` default, and `FDRIVE_SETUP_TOKEN` (meaningless once
 * `SFTPGO_URL` is set, so this template never needs it). Exported so the
 * diff test and the generator share one list.
 */
export const COMPOSE_PASSTHROUGH_EXCLUDED_KEYS: ReadonlySet<string> = new Set([
  "PORT",
  "DATABASE_URL",
  "SFTPGO_URL",
  "FDRIVE_MASTER_KEY",
  "FDRIVE_THUMBS_DIR",
  "FDRIVE_OCR_URL",
  "FDRIVE_INDEXER_URL",
  "FDRIVE_EMBED_URL",
  "FDRIVE_IMAGE_EMBED_URL",
  "FDRIVE_INDEX_ROOTS",
  "FDRIVE_SETUP_TOKEN",
]);

/**
 * `CONFIG_KEYS` entries `deploy/compose.yaml` never reads from `.env` at
 * all, so `deploy/.env.example` (which documents "every environment
 * variable used by the files" in `deploy/`) must not list them either:
 * `PORT` and `DATABASE_URL` are fixed or computed inline, the five sidecar
 * URLs are fixed compose-internal addresses, `FDRIVE_INDEX_ROOTS` is a
 * computed literal (operators use `FDRIVE_INDEX_SFTPGO_PATH` instead, see
 * `DEPLOY_EXTRA_KEYS`), and `FDRIVE_SETUP_TOKEN` is meaningless once
 * `SFTPGO_URL` is set, which every deploy template here does.
 * `SFTPGO_URL` and `FDRIVE_MASTER_KEY` are deliberately absent from this
 * set: compose reads both directly from `.env` even though they are not
 * part of the generated passthrough block (they have no safe default).
 */
export const ENV_EXAMPLE_EXCLUDED_KEYS: ReadonlySet<string> = new Set([
  "PORT",
  "DATABASE_URL",
  "FDRIVE_THUMBS_DIR",
  "FDRIVE_OCR_URL",
  "FDRIVE_INDEXER_URL",
  "FDRIVE_EMBED_URL",
  "FDRIVE_IMAGE_EMBED_URL",
  "FDRIVE_INDEX_ROOTS",
  "FDRIVE_SETUP_TOKEN",
]);

/** Groups `keys` by subsystem, in `SUBSYSTEMS` order, dropping empty groups. */
export function groupBySubsystem(
  keys: readonly ConfigKeyDef[],
): ReadonlyArray<{ subsystem: Subsystem; entries: readonly ConfigKeyDef[] }> {
  const groups: Array<{ subsystem: Subsystem; entries: ConfigKeyDef[] }> = [];
  for (const subsystem of SUBSYSTEMS) {
    const entries = keys.filter((entry) => entry.subsystem === subsystem);
    if (entries.length > 0) {
      groups.push({ subsystem, entries });
    }
  }
  return groups;
}

/** Renders one key's `.env.example` block: name, description, default/example, and the assignment line itself. */
export function renderEnvExampleEntry(entry: ConfigKeyDef): string {
  const lines = [`# ${entry.key}${entry.secret ? " (secret)" : ""}`, `# ${entry.description}`];
  if (entry.secret) {
    lines.push(`${entry.key}=change-me`);
  } else if (entry.default !== null) {
    lines.push(`# default: ${entry.default}`);
    if (entry.example !== entry.default) {
      lines.push(`# example: ${entry.example}`);
    }
    lines.push(`#${entry.key}=${entry.default}`);
  } else {
    lines.push(`# example: ${entry.example}`);
    lines.push(`#${entry.key}=`);
  }
  return lines.join("\n");
}

/**
 * Renders the full `deploy/.env.example` file from `CONFIG_KEYS` and
 * `DEPLOY_EXTRA_KEYS`: a short header, then one section per subsystem, each
 * key documented with its description, default, a commented example, and
 * secrets marked. Pure and deterministic, so `env-example.test.ts` can
 * regenerate it into memory and diff it against the committed file.
 */
export function renderEnvExample(
  configKeys: readonly ConfigKeyDef[] = CONFIG_KEYS,
  deployKeys: readonly ConfigKeyDef[] = DEPLOY_EXTRA_KEYS,
  excluded: ReadonlySet<string> = ENV_EXAMPLE_EXCLUDED_KEYS,
): string {
  const header = [
    "# fdrive deploy environment.",
    "#",
    "# Generated by tools/deploy/generate-env-example.ts (`pnpm env:example`); do not hand-edit.",
    "# Copy to .env, then fill in every uncommented change-me value:",
    "#   cp .env.example .env && chmod 600 .env",
    "# Uncomment and edit any commented #KEY=value line to enable or override that subsystem.",
    "# An empty or commented-out value is treated the same as the variable being unset.",
  ].join("\n");

  const documented = [...configKeys.filter((entry) => !excluded.has(entry.key)), ...deployKeys];
  const sections = groupBySubsystem(documented).map(({ subsystem, entries }) => {
    const title = `# ---- ${SUBSYSTEM_TITLES[subsystem]} ----`;
    return [title, ...entries.map(renderEnvExampleEntry)].join("\n\n");
  });

  return `${[header, ...sections].join("\n\n")}\n`;
}

/**
 * Renders `deploy/compose.yaml`'s generated passthrough block: every
 * non-secret `CONFIG_KEYS` entry not in `excluded`, as `KEY: ${KEY:-}` at
 * six-space indent (matching the `api.environment` block's existing
 * entries), in table order.
 */
export function renderComposePassthroughLines(
  configKeys: readonly ConfigKeyDef[] = CONFIG_KEYS,
  excluded: ReadonlySet<string> = COMPOSE_PASSTHROUGH_EXCLUDED_KEYS,
): string[] {
  return configKeys
    .filter((entry) => !entry.secret && !excluded.has(entry.key))
    .map((entry) => `      ${entry.key}: \${${entry.key}:-}`);
}

/**
 * Replaces the lines strictly between `beginMarker` and `endMarker`
 * (leaving both marker lines themselves in place) in `source` with
 * `replacementLines`. Throws when either marker is missing or out of
 * order, so a hand-edited generated file that lost its markers fails
 * loudly instead of silently skipping regeneration. Shared by the
 * `compose.yaml` passthrough block and `preflight.sh`'s known-keys array.
 */
export function replaceBetweenMarkers(
  source: string,
  beginMarker: string,
  endMarker: string,
  replacementLines: readonly string[],
): string {
  const lines = source.split("\n");
  const beginIndex = lines.indexOf(beginMarker);
  const endIndex = lines.indexOf(endMarker);
  if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) {
    throw new Error(
      `source is missing its generated markers (${beginMarker.trim()} / ${endMarker.trim()})`,
    );
  }
  const before = lines.slice(0, beginIndex + 1);
  const after = lines.slice(endIndex);
  return [...before, ...replacementLines, ...after].join("\n");
}

const COMPOSE_BEGIN_MARKER =
  "      # BEGIN GENERATED CONFIG KEYS (tools/deploy/generate-env-example.ts)";
const COMPOSE_END_MARKER = "      # END GENERATED CONFIG KEYS";

/**
 * Replaces `deploy/compose.yaml`'s generated passthrough block (between its
 * markers) with `passthroughLines`.
 */
export function applyComposePassthroughBlock(
  composeSource: string,
  passthroughLines: readonly string[],
): string {
  return replaceBetweenMarkers(
    composeSource,
    COMPOSE_BEGIN_MARKER,
    COMPOSE_END_MARKER,
    passthroughLines,
  );
}

const PREFLIGHT_BEGIN_MARKER =
  "# BEGIN GENERATED KNOWN FDRIVE KEYS (tools/deploy/generate-env-example.ts)";
const PREFLIGHT_END_MARKER = "# END GENERATED KNOWN FDRIVE KEYS";

/**
 * Every `FDRIVE_*` key an operator might legitimately set in `deploy/.env`:
 * every `CONFIG_KEYS` entry `deploy/.env.example` documents (so excludes
 * the compose-internal-fixed ones) plus every `FDRIVE_*` `DEPLOY_EXTRA_KEYS`
 * entry. `preflight.sh` flags any other `FDRIVE_*` key in `.env` as a
 * likely typo.
 */
export function knownFdriveKeys(
  configKeys: readonly ConfigKeyDef[] = CONFIG_KEYS,
  deployKeys: readonly ConfigKeyDef[] = DEPLOY_EXTRA_KEYS,
  envExampleExcluded: ReadonlySet<string> = ENV_EXAMPLE_EXCLUDED_KEYS,
): string[] {
  return [...configKeys.filter((entry) => !envExampleExcluded.has(entry.key)), ...deployKeys]
    .map((entry) => entry.key)
    .filter((key) => key.startsWith("FDRIVE_"));
}

/** Renders `knownFdriveKeys()`'s result as a `bash` array literal, one key per line, four-space indented. */
export function renderKnownFdriveKeysBashArray(keys: readonly string[]): string[] {
  return ["KNOWN_FDRIVE_KEYS=(", ...keys.map((key) => `    "${key}"`), ")"];
}

/** Replaces `preflight.sh`'s generated `KNOWN_FDRIVE_KEYS` array (between its markers) with `arrayLines`. */
export function applyPreflightKnownKeysBlock(
  preflightSource: string,
  arrayLines: readonly string[],
): string {
  return replaceBetweenMarkers(
    preflightSource,
    PREFLIGHT_BEGIN_MARKER,
    PREFLIGHT_END_MARKER,
    arrayLines,
  );
}
