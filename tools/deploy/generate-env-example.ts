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
 * `FDRIVE_INDEX_ROOTS` default, and the optional secret `FDRIVE_SETUP_TOKEN`.
 * Exported so the
 * diff test and the generator share one list.
 */
export const COMPOSE_PASSTHROUGH_EXCLUDED_KEYS: ReadonlySet<string> = new Set([
  "FDRIVE_BACKUP_STATE_DIR",
  "FDRIVE_BACKUP_WORKER",
  "FDRIVE_BACKUP_SOURCES",
  "FDRIVE_DESKTOP_STATE_DIR",
  "FDRIVE_EMBED_RUNTIME_URL",
  "FDRIVE_IMAGE_EMBED_RUNTIME_URL",
  "FDRIVE_TIKA_RUNTIME_URL",
  "FDRIVE_TIKA_URL",

  "NODE_ENV",
  "FDRIVE_WORKER_TOKEN",
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
  "FDRIVE_OFFICE_PRODUCT",
  "FDRIVE_OFFICE_URL",
  "FDRIVE_WOPI_URL",
]);

/**
 * `CONFIG_KEYS` entries `deploy/compose.yaml` never reads from `.env` at
 * all, so `deploy/.env.example` (which documents "every environment
 * variable used by the files" in `deploy/`) must not list them either:
 * `PORT` and `DATABASE_URL` are fixed or computed inline, the five sidecar
 * URLs are fixed compose-internal addresses, `FDRIVE_INDEX_ROOTS` is a
 * computed literal (operators use `FDRIVE_INDEX_SFTPGO_PATH` instead, see
 * `DEPLOY_EXTRA_KEYS`).
 * `SFTPGO_URL` and `FDRIVE_MASTER_KEY` are deliberately absent from this
 * set: compose reads both directly from `.env` even though they are not
 * part of the generated passthrough block (they have no safe default).
 */
export const ENV_EXAMPLE_EXCLUDED_KEYS: ReadonlySet<string> = new Set([
  "FDRIVE_BACKUP_STATE_DIR",
  "FDRIVE_BACKUP_WORKER",
  "FDRIVE_BACKUP_SOURCES",
  "FDRIVE_DESKTOP_STATE_DIR",
  "NODE_ENV",
  "FDRIVE_WORKER_TOKEN",
  "PORT",
  "DATABASE_URL",
  "FDRIVE_THUMBS_DIR",
  "FDRIVE_OCR_URL",
  "FDRIVE_INDEXER_URL",
  "FDRIVE_EMBED_URL",
  "FDRIVE_IMAGE_EMBED_URL",
  "FDRIVE_INDEX_ROOTS",
]);

/** Fresh installs need only secrets; connection and features are chosen in the
 * walkthrough. The complete environment catalog remains available to tooling
 * and the advanced reference. */
const QUICKSTART_CONFIG_KEYS = new Set(["SFTPGO_URL", "FDRIVE_MASTER_KEY"]);
const QUICKSTART_DEPLOY_KEYS = new Set(["POSTGRES_PASSWORD"]);

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
    "# Save as .env next to compose.yaml and replace every uncommented change-me value.",
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

/** Render the intentionally small production template. `SFTPGO_URL` stays
 * commented because the first-run walkthrough can configure it safely. */
export function renderQuickstartEnvExample(): string {
  const configKeys = CONFIG_KEYS.filter((entry) => QUICKSTART_CONFIG_KEYS.has(entry.key));
  const deployKeys = DEPLOY_EXTRA_KEYS.filter((entry) => QUICKSTART_DEPLOY_KEYS.has(entry.key));
  const header = [
    "# fdrive quick-start environment.",
    "#",
    "# Generated by tools/deploy/generate-env-example.ts (`pnpm env:example`); do not hand-edit.",
    "# Save as .env next to compose.yaml and replace every uncommented change-me value.",
    "# Leave SFTPGO_URL unset to configure and test it in the first-run walkthrough.",
    "# Advanced host mounts, networking, Office, and processing worker resource limits: REFERENCE.md.",
  ].join("\n");
  const sections = groupBySubsystem([...configKeys, ...deployKeys]).map(
    ({ subsystem, entries }) => {
      return [
        `# ---- ${SUBSYSTEM_TITLES[subsystem]} ----`,
        ...entries.map(renderEnvExampleEntry),
      ].join("\n\n");
    },
  );
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
 * loudly instead of silently skipping regeneration.
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

/**
 * Every `FDRIVE_*` key an operator might legitimately set in `deploy/.env`:
 * every `CONFIG_KEYS` entry `deploy/.env.example` documents (so excludes
 * the compose-internal-fixed ones) plus every `FDRIVE_*` `DEPLOY_EXTRA_KEYS`
 * entry. Every `${FDRIVE_*}` a compose file reads must be one of them, so
 * each setting an operator can put in `.env` is documented.
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

/** Complete host-process API reference, using the same config catalog as deploy. */
export function renderApiEnvExample(): string {
  return (
    [
      "# API host-process configuration. Generated by pnpm env:example; do not hand-edit.",
      "# For the disposable development stack, prefer pnpm dev:env.",
      "# Required: DATABASE_URL and FDRIVE_MASTER_KEY. All other keys are optional.",
      ...CONFIG_KEYS.map((entry) =>
        [
          `# ${entry.description}`,
          entry.key === "DATABASE_URL" || entry.key === "FDRIVE_MASTER_KEY"
            ? `${entry.key}=`
            : `#${entry.key}=${entry.default ?? ""}`,
        ].join("\n"),
      ),
      "",
    ]
      .join("\n\n")
      .trimEnd() + "\n"
  );
}
