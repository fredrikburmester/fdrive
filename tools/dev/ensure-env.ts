/**
 * Creates apps/api/.env.dev and apps/web/.env.local if they do not already
 * exist, so `pnpm dev:env` gives a fresh clone a working local environment
 * without overwriting anything a developer has already customized. Both
 * files are gitignored (see the root and apps/web .gitignore, which ignore
 * `.env*` except `.env.example`).
 *
 * It also upserts the keys search, OCR, and thumbnails need
 * (`FDRIVE_INDEX_ROOTS`, `FDRIVE_EMBED_URL`, `FDRIVE_THUMBS_DIR`,
 * `FDRIVE_INDEXER_URL`, `FDRIVE_OCR_URL`, `FDRIVE_ADMIN_USERS`,
 * `FDRIVE_SFTPGO_TRASH_PATH`) into `apps/api/.env.dev`, whether that file
 * is freshly created or already existed, without touching any key already
 * present. This lets `pnpm dev:env` grow the file's contents across
 * versions of this script instead of only ever writing it once.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Permission bits every generated env file gets: owner read-write only. */
export const ENV_FILE_MODE = 0o600;

/** Generates a fresh FDRIVE_MASTER_KEY: 32 random bytes, base64-encoded. */
export function generateMasterKey(randomBytesFn: (size: number) => Buffer = randomBytes): string {
  return randomBytesFn(32).toString("base64");
}

export interface EnvFileSpec {
  readonly path: string;
  readonly contents: string;
}

/**
 * Builds the apps/api/.env.dev contents. Pure aside from taking the master
 * key as an argument so tests can supply a fixed one.
 */
export function buildApiEnvDev(masterKey: string): string {
  return [
    "PORT=3001",
    "HOST=127.0.0.1",
    "LOG_LEVEL=debug",
    "NODE_ENV=development",
    "DATABASE_URL=postgres://fdrive:fdrive-dev@127.0.0.1:55432/fdrive",
    "SFTPGO_URL=http://127.0.0.1:58080",
    `FDRIVE_MASTER_KEY=${masterKey}`,
    "FDRIVE_HOME_TEMPLATE=sftpgo:/{username}",
    "FDRIVE_COOKIE_SECURE=false",
    "FDRIVE_PUBLIC_URL=http://localhost:3000",
    "",
  ].join("\n");
}

/** Builds the apps/web/.env.local contents. */
export function buildWebEnvLocal(): string {
  return ["API_INTERNAL_URL=http://127.0.0.1:3001", ""].join("\n");
}

/**
 * The dev environment's search, OCR, and thumbnails config, keyed by the
 * `FDRIVE_*` variable name (see `apps/api/src/config.ts`). Matches
 * `deploy/compose.dev.yaml`'s `embed`, `indexer`, and `ocr` published ports
 * and bind-mounted thumbnails directory: 127.0.0.1:58081, 127.0.0.1:58010,
 * 127.0.0.1:58011, and `deploy/dev/.data/thumbs` under `repoRoot`
 * respectively. `dev` is granted admin in the dev environment so the System
 * pages are reachable without extra setup. `FDRIVE_SFTPGO_TRASH_PATH`
 * matches the recycle-folder rule `tools/dev/generate-seed.ts` seeds into
 * the dev SFTPGo container, so the dev Trash view works out of the box.
 */
export function buildDevSearchEnv(repoRoot: string): Record<string, string> {
  return {
    FDRIVE_INDEX_ROOTS: JSON.stringify([
      { name: "sftpgo", sftpgoPath: "/srv/sftpgo/data", indexerPath: "/roots/sftpgo" },
    ]),
    FDRIVE_EMBED_URL: "http://127.0.0.1:58081",
    FDRIVE_THUMBS_DIR: join(repoRoot, "deploy", "dev", ".data", "thumbs"),
    FDRIVE_INDEXER_URL: "http://127.0.0.1:58010",
    FDRIVE_OCR_URL: "http://127.0.0.1:58011",
    FDRIVE_ADMIN_USERS: "dev",
    FDRIVE_SFTPGO_TRASH_PATH: "/.trash",
  };
}

/**
 * Characters an unquoted value in a Node `--env-file` line can safely
 * contain: none of the whitespace, quote, or `#` characters that would end
 * the value early or start a comment. See `quoteEnvValue`.
 */
function isSafeUnquotedEnvValue(value: string): boolean {
  return value.length > 0 && !/[\s"'#]/.test(value);
}

/**
 * Quotes `value` for a `KEY=value` line in a file meant to be read with
 * Node's `--env-file` flag, only when it needs it (contains whitespace, a
 * quote character, or `#`; JSON values always need this). Node's env file
 * parser does not support backslash-escaping a quote of the same kind used
 * to wrap the value, so this prefers single quotes for values (like our
 * JSON) that contain double quotes but never single quotes, and falls back
 * to double quotes otherwise.
 */
export function quoteEnvValue(value: string): string {
  if (isSafeUnquotedEnvValue(value)) {
    return value;
  }
  if (!value.includes("'")) {
    return `'${value}'`;
  }
  return `"${value}"`;
}

/**
 * Parses the `KEY` out of a `.env`-style line, or `undefined` for a line
 * that is not a `KEY=value` assignment (blank lines, comments).
 */
function envLineKey(line: string): string | undefined {
  return /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1];
}

/**
 * Appends whichever of `additions` are not already assigned in `existing`,
 * leaving every present key's line untouched. Pure string manipulation, so
 * both a freshly generated file and one a developer has edited go through
 * the same logic. Returns `existing` unchanged (same reference) when
 * nothing needs adding, so callers can skip writing the file.
 */
export function upsertEnv(existing: string, additions: Record<string, string>): string {
  const presentKeys = new Set(
    existing
      .split("\n")
      .map(envLineKey)
      .filter((key): key is string => key !== undefined),
  );

  const toAdd = Object.entries(additions).filter(([key]) => !presentKeys.has(key));
  if (toAdd.length === 0) {
    return existing;
  }

  const trimmed = existing.replace(/\n+$/, "");
  const prefix = trimmed.length > 0 ? `${trimmed}\n` : "";
  const addedLines = toAdd.map(([key, value]) => `${key}=${quoteEnvValue(value)}`).join("\n");
  return `${prefix}${addedLines}\n`;
}

export interface ApiEnvDevPlan {
  readonly contents: string;
  /** Keys from `additions` that were not already present before this run. */
  readonly addedKeys: readonly string[];
}

/**
 * Works out the next contents of `apps/api/.env.dev` given its current
 * contents (`undefined` when the file does not exist yet, in which case a
 * fresh file is generated from `masterKey`) and the keys `additions` should
 * contribute. Pure, so the "create" and "upsert into an existing file"
 * paths share one tested code path.
 */
export function planApiEnvDev(
  existing: string | undefined,
  additions: Record<string, string>,
  masterKey: string,
): ApiEnvDevPlan {
  const before = existing ?? buildApiEnvDev(masterKey);
  const beforeKeys = new Set(
    before
      .split("\n")
      .map(envLineKey)
      .filter((key): key is string => key !== undefined),
  );
  const addedKeys = Object.keys(additions).filter((key) => !beforeKeys.has(key));
  return { contents: upsertEnv(before, additions), addedKeys };
}

/**
 * Writes `contents` to `path` with owner-only permissions (`ENV_FILE_MODE`,
 * 0600): these files hold secrets (`FDRIVE_MASTER_KEY`, database
 * credentials), so a stray group- or world-readable file is not
 * acceptable. `writeFileSync`'s `mode` option only takes effect for a file
 * it creates; an already-existing file keeps whatever permissions it had
 * before, so this always follows up with an explicit `chmodSync`, which
 * covers both the fresh-file and updated-existing-file cases the same way.
 */
export function writeEnvFile(
  path: string,
  contents: string,
  fns: {
    readonly writeFileSync: typeof writeFileSync;
    readonly chmodSync: typeof chmodSync;
  } = { writeFileSync, chmodSync },
): void {
  fns.writeFileSync(path, contents, { encoding: "utf-8", mode: ENV_FILE_MODE });
  fns.chmodSync(path, ENV_FILE_MODE);
}

/**
 * Writes `spec.contents` to `spec.path` only if no file already exists
 * there, creating parent directories as needed. Returns whether it wrote
 * the file (false means it was left alone because it already existed).
 */
export function ensureEnvFile(
  spec: EnvFileSpec,
  exists: (path: string) => boolean = existsSync,
): boolean {
  if (exists(spec.path)) {
    return false;
  }
  mkdirSync(dirname(spec.path), { recursive: true });
  writeEnvFile(spec.path, spec.contents);
  return true;
}

function main(): void {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(scriptDir, "..", "..");
  const apiEnvPath = join(repoRoot, "apps", "api", ".env.dev");
  const webEnvPath = join(repoRoot, "apps", "web", ".env.local");

  const apiEnvExisted = existsSync(apiEnvPath);
  const existingApiEnv = apiEnvExisted ? readFileSync(apiEnvPath, "utf-8") : undefined;
  const plan = planApiEnvDev(existingApiEnv, buildDevSearchEnv(repoRoot), generateMasterKey());

  if (!apiEnvExisted) {
    mkdirSync(dirname(apiEnvPath), { recursive: true });
    writeEnvFile(apiEnvPath, plan.contents);
    console.log(`Created ${apiEnvPath}`);
  } else if (plan.addedKeys.length > 0) {
    writeEnvFile(apiEnvPath, plan.contents);
    console.log(`Updated ${apiEnvPath} (added ${plan.addedKeys.join(", ")})`);
  } else {
    console.log(`Skipped ${apiEnvPath} (already exists)`);
  }

  const wroteWeb = ensureEnvFile({ path: webEnvPath, contents: buildWebEnvLocal() });
  console.log(wroteWeb ? `Created ${webEnvPath}` : `Skipped ${webEnvPath} (already exists)`);
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main();
}
