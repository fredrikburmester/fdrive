/**
 * Creates apps/api/.env.dev and apps/web/.env.local if they do not already
 * exist, so `pnpm dev:env` gives a fresh clone a working local environment
 * without overwriting anything a developer has already customized. Both
 * files are gitignored (see the root and apps/web .gitignore, which ignore
 * `.env*` except `.env.example`).
 *
 * It also upserts the keys the local folder, search, OCR, and thumbnails
 * need (`FDRIVE_STORAGE_ROOT`, `FDRIVE_INDEX_ROOTS`, `FDRIVE_EMBED_URL`,
 * `FDRIVE_THUMBS_DIR`, `FDRIVE_INDEXER_URL`, `FDRIVE_OCR_URL`,
 * `FDRIVE_ADMIN_USERS`) into `apps/api/.env.dev`, whether that file is
 * freshly created or already existed, without touching any key already
 * present. This lets `pnpm dev:env` grow the file's contents across
 * versions of this script instead of only ever writing it once. Values an
 * earlier version wrote are replaced (`isObsoleteApiEnvLine`): SFTPGo's keys
 * and root, and a storage root that served the committed seed itself.
 *
 * Finally it copies the committed dev homes (`deploy/dev/files`) into the
 * gitignored folder the api serves (`deploy/dev/.data/files`) when that is
 * missing or empty; `--reset`, which `pnpm dev:env:reset` passes, replaces
 * it with a fresh copy.
 */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

type DevEnv = Readonly<Record<string, string | undefined>>;

function devPort(env: DevEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${key} must be a TCP port between 1 and 65535`);
  }
  return port;
}

/**
 * Builds the apps/api/.env.dev contents. Pure aside from taking the master
 * key as an argument so tests can supply a fixed one.
 */
export function buildApiEnvDev(masterKey: string, env: DevEnv = {}): string {
  return [
    `PORT=${devPort(env, "FDRIVE_DEV_API_PORT", 3001)}`,
    "HOST=127.0.0.1",
    "LOG_LEVEL=debug",
    "NODE_ENV=development",
    `DATABASE_URL=postgres://fdrive:fdrive-dev@127.0.0.1:${devPort(env, "FDRIVE_DEV_DB_PORT", 55432)}/fdrive`,
    `FDRIVE_MASTER_KEY=${masterKey}`,
    "FDRIVE_COOKIE_SECURE=false",
    "",
  ].join("\n");
}

/** Builds the apps/web/.env.local contents. */
export function buildWebEnvLocal(env: DevEnv = {}): string {
  return [
    `API_INTERNAL_URL=http://127.0.0.1:${devPort(env, "FDRIVE_DEV_API_PORT", 3001)}`,
    "",
  ].join("\n");
}

/** The committed dev homes `pnpm dev:seed` writes: the seed, never served itself. */
export function devSeedDir(repoRoot: string): string {
  return join(repoRoot, "deploy", "dev", "files");
}

/**
 * The folder the api dev server serves and the dev indexer and OCR mount: a
 * gitignored copy of the seed, so files changed in the dev app never show up
 * in git.
 */
export function devStorageRoot(repoRoot: string): string {
  return join(repoRoot, "deploy", "dev", ".data", "files");
}

/**
 * Copies the seed into the served folder when that folder is missing or
 * empty (Docker creates an empty one when the dev stack starts first). With
 * `reset`, what dev use left there is removed first, so it starts from a
 * fresh copy. Returns whether it copied.
 */
export function ensureDevFiles(seedDir: string, filesDir: string, reset = false): boolean {
  if (reset) {
    rmSync(filesDir, { recursive: true, force: true });
  } else if (existsSync(filesDir) && readdirSync(filesDir).length > 0) {
    return false;
  }
  mkdirSync(filesDir, { recursive: true });
  cpSync(seedDir, filesDir, { recursive: true });
  return true;
}

/**
 * The dev environment's local folder, search, OCR, and thumbnails config,
 * keyed by the `FDRIVE_*` variable name (see `apps/api/src/config.ts`).
 * Matches `deploy/compose.dev.yaml`: the api on the host serves
 * `deploy/dev/.data/files` (`devStorageRoot`), which the indexer and OCR
 * containers mount at `/data` as the root `files`; the `ml`, `indexer`, and `ocr` published ports are
 * 127.0.0.1:58012 (one prefix per unit of the ml service), 127.0.0.1:58010,
 * and 127.0.0.1:58011; thumbnails land in `deploy/dev/.data/thumbs` under
 * `repoRoot`. `dev` is granted admin in the dev environment so the System
 * pages are reachable without extra setup.
 */
export function buildDevSearchEnv(repoRoot: string, env: DevEnv = {}): Record<string, string> {
  const ml = `http://127.0.0.1:${devPort(env, "FDRIVE_DEV_ML_PORT", 58012)}`;
  const storageRoot = devStorageRoot(repoRoot);
  return {
    FDRIVE_STORAGE_ROOT: storageRoot,
    FDRIVE_INDEX_ROOTS: JSON.stringify([
      { name: "files", storagePath: storageRoot, indexerPath: "/data" },
    ]),
    FDRIVE_EMBED_URL: `${ml}/text`,
    FDRIVE_THUMBS_DIR: join(repoRoot, "deploy", "dev", ".data", "thumbs"),
    FDRIVE_INDEXER_URL: `http://127.0.0.1:${devPort(env, "FDRIVE_DEV_INDEXER_HTTP_PORT", 58010)}`,
    FDRIVE_OCR_URL: `http://127.0.0.1:${devPort(env, "FDRIVE_DEV_OCR_HTTP_PORT", 58011)}`,
    FDRIVE_IMAGE_EMBED_URL: `${ml}/image`,
    FDRIVE_ADMIN_USERS: "dev",
    FDRIVE_TIKA_URL: `${ml}/extract`,
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

/** Keys earlier versions of this script wrote for SFTPGo, which the api no longer reads. */
export const OBSOLETE_API_ENV_KEYS: readonly string[] = ["SFTPGO_URL", "FDRIVE_HOME_TEMPLATE"];

/** A `KEY=value` line's value, without the quotes `quoteEnvValue` may have added. */
function envLineValue(line: string): string {
  const value = line.slice(line.indexOf("=") + 1);
  const quoted = /^(['"])(.*)\1$/.exec(value);
  return quoted?.[2] ?? value;
}

/** The `storagePath` of each root in an `FDRIVE_INDEX_ROOTS` value; none when it is not JSON. */
function indexRootStoragePaths(value: string): unknown[] {
  try {
    const roots: unknown = JSON.parse(value);
    return Array.isArray(roots)
      ? roots.map((root: unknown) =>
          typeof root === "object" && root !== null && "storagePath" in root
            ? root.storagePath
            : undefined,
        )
      : [];
  } catch {
    return [];
  }
}

/**
 * True for a line an earlier version of this script wrote that must go:
 * an obsolete key, an `FDRIVE_INDEX_ROOTS` that still names the `sftpgo`
 * root, or, given `seedDir`, an `FDRIVE_STORAGE_ROOT` or index root that
 * serves the committed seed instead of its gitignored copy. A developer's
 * own values are left alone.
 */
export function isObsoleteApiEnvLine(line: string, seedDir?: string): boolean {
  const key = envLineKey(line);
  if (key === undefined) return false;
  if (OBSOLETE_API_ENV_KEYS.includes(key)) return true;
  if (key === "FDRIVE_STORAGE_ROOT") {
    return seedDir !== undefined && envLineValue(line) === seedDir;
  }
  if (key !== "FDRIVE_INDEX_ROOTS") return false;
  if (/"name"\s*:\s*"sftpgo"/.test(line)) return true;
  return seedDir !== undefined && indexRootStoragePaths(envLineValue(line)).includes(seedDir);
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
  /** Keys whose obsolete lines were removed (`isObsoleteApiEnvLine`). */
  readonly removedKeys: readonly string[];
}

/**
 * Works out the next contents of `apps/api/.env.dev` given its current
 * contents (`undefined` when the file does not exist yet, in which case a
 * fresh file is generated from `masterKey`) and the keys `additions` should
 * contribute. Obsolete lines (`isObsoleteApiEnvLine`, with `seedDir`) are
 * dropped first, so a replaced key comes back from `additions`. Pure, so
 * the "create" and "upsert into an existing file" paths share one tested
 * code path.
 */
export function planApiEnvDev(
  existing: string | undefined,
  additions: Record<string, string>,
  masterKey: string,
  env: DevEnv = {},
  seedDir?: string,
): ApiEnvDevPlan {
  const lines = (existing ?? buildApiEnvDev(masterKey, env)).split("\n");
  const obsolete = (line: string) => isObsoleteApiEnvLine(line, seedDir);
  const removed = lines.filter(obsolete);
  const before = lines.filter((line) => !obsolete(line)).join("\n");
  const beforeKeys = new Set(
    before
      .split("\n")
      .map(envLineKey)
      .filter((key): key is string => key !== undefined),
  );
  const addedKeys = Object.keys(additions).filter((key) => !beforeKeys.has(key));
  const removedKeys = removed
    .map(envLineKey)
    .filter((key): key is string => key !== undefined && !addedKeys.includes(key));
  return { contents: upsertEnv(before, additions), addedKeys, removedKeys };
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
  const plan = planApiEnvDev(
    existingApiEnv,
    buildDevSearchEnv(repoRoot, process.env),
    generateMasterKey(),
    process.env,
    devSeedDir(repoRoot),
  );

  if (!apiEnvExisted) {
    mkdirSync(dirname(apiEnvPath), { recursive: true });
    writeEnvFile(apiEnvPath, plan.contents);
    console.log(`Created ${apiEnvPath}`);
  } else if (plan.addedKeys.length > 0 || plan.removedKeys.length > 0) {
    writeEnvFile(apiEnvPath, plan.contents);
    const changes = [
      plan.addedKeys.length > 0 ? `added ${plan.addedKeys.join(", ")}` : "",
      plan.removedKeys.length > 0 ? `removed ${plan.removedKeys.join(", ")}` : "",
    ].filter((change) => change !== "");
    console.log(`Updated ${apiEnvPath} (${changes.join("; ")})`);
  } else {
    console.log(`Skipped ${apiEnvPath} (already exists)`);
  }

  const wroteWeb = ensureEnvFile({ path: webEnvPath, contents: buildWebEnvLocal(process.env) });
  console.log(wroteWeb ? `Created ${webEnvPath}` : `Skipped ${webEnvPath} (already exists)`);

  const filesDir = devStorageRoot(repoRoot);
  const copied = ensureDevFiles(devSeedDir(repoRoot), filesDir, process.argv.includes("--reset"));
  console.log(copied ? `Copied the dev files to ${filesDir}` : `Kept ${filesDir}`);
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main();
}
