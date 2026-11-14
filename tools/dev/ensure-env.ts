/**
 * Writes apps/api/.env.dev and apps/web/.env.local when they are missing, so
 * `pnpm dev:env` gives a fresh clone a working local environment and leaves a
 * developer's own files alone. `--reset`, which `pnpm dev:env:reset` passes
 * after wiping the database, writes both again from scratch. Both files are
 * gitignored (see the root and apps/web .gitignore, which ignore `.env*`
 * except `.env.example`).
 *
 * It also copies the committed dev homes (`deploy/dev/files`) into the
 * gitignored folder the api serves (`deploy/dev/.data/files`) when that is
 * missing or empty; `--reset` replaces it with a fresh copy.
 */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
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

/** Builds the apps/web/.env.local contents. */
export function buildWebEnvLocal(env: DevEnv = {}): string {
  return formatEnv({
    API_INTERNAL_URL: `http://127.0.0.1:${devPort(env, "FDRIVE_DEV_API_PORT", 3001)}`,
  });
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
 * The apps/api/.env.dev variables, keyed by name (see `apps/api/src/config.ts`).
 * Matches `deploy/compose.dev.yaml`: the api on the host serves
 * `deploy/dev/.data/files` (`devStorageRoot`), which the indexer and OCR
 * containers mount at `/data` as the root `files`; the `ml`, `indexer`, and
 * `ocr` published ports are 127.0.0.1:58012 (one prefix per unit of the ml
 * service), 127.0.0.1:58010, and 127.0.0.1:58011; thumbnails land in
 * `deploy/dev/.data/thumbs` under `repoRoot`. `dev` is granted admin so the
 * System pages are reachable without extra setup. Takes the master key as an
 * argument so tests can supply a fixed one.
 */
export function buildApiEnv(
  repoRoot: string,
  masterKey: string,
  env: DevEnv = {},
): Record<string, string> {
  const ml = `http://127.0.0.1:${devPort(env, "FDRIVE_DEV_ML_PORT", 58012)}`;
  const storageRoot = devStorageRoot(repoRoot);
  return {
    PORT: String(devPort(env, "FDRIVE_DEV_API_PORT", 3001)),
    HOST: "127.0.0.1",
    LOG_LEVEL: "debug",
    NODE_ENV: "development",
    DATABASE_URL: `postgres://fdrive:fdrive-dev@127.0.0.1:${devPort(env, "FDRIVE_DEV_DB_PORT", 55432)}/fdrive`,
    FDRIVE_MASTER_KEY: masterKey,
    FDRIVE_COOKIE_SECURE: "false",
    FDRIVE_STORAGE_ROOT: storageRoot,
    FDRIVE_INDEX_ROOTS: JSON.stringify([
      { name: "files", storagePath: storageRoot, indexerPath: "/data" },
    ]),
    FDRIVE_EMBED_URL: `${ml}/text`,
    FDRIVE_IMAGE_EMBED_URL: `${ml}/image`,
    FDRIVE_TIKA_URL: `${ml}/extract`,
    FDRIVE_THUMBS_DIR: join(repoRoot, "deploy", "dev", ".data", "thumbs"),
    FDRIVE_INDEXER_URL: `http://127.0.0.1:${devPort(env, "FDRIVE_DEV_INDEXER_HTTP_PORT", 58010)}`,
    FDRIVE_OCR_URL: `http://127.0.0.1:${devPort(env, "FDRIVE_DEV_OCR_HTTP_PORT", 58011)}`,
    FDRIVE_ADMIN_USERS: "dev",
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

/** `KEY=value` lines for Node's `--env-file`, each value quoted only when it needs it. */
export function formatEnv(vars: Readonly<Record<string, string>>): string {
  const lines = Object.entries(vars).map(([key, value]) => `${key}=${quoteEnvValue(value)}`);
  return `${lines.join("\n")}\n`;
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
 * Writes `spec.contents` to `spec.path` when no file exists there, or always
 * with `reset`, creating parent directories as needed. Returns whether it
 * wrote the file (false means it kept the one already there).
 */
export function ensureEnvFile(
  spec: EnvFileSpec,
  reset = false,
  exists: (path: string) => boolean = existsSync,
): boolean {
  if (!reset && exists(spec.path)) {
    return false;
  }
  mkdirSync(dirname(spec.path), { recursive: true });
  writeEnvFile(spec.path, spec.contents);
  return true;
}

function main(): void {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(scriptDir, "..", "..");
  const reset = process.argv.includes("--reset");

  const envFiles: EnvFileSpec[] = [
    {
      path: join(repoRoot, "apps", "api", ".env.dev"),
      contents: formatEnv(buildApiEnv(repoRoot, generateMasterKey(), process.env)),
    },
    { path: join(repoRoot, "apps", "web", ".env.local"), contents: buildWebEnvLocal(process.env) },
  ];
  for (const spec of envFiles) {
    const wrote = ensureEnvFile(spec, reset);
    console.log(wrote ? `Wrote ${spec.path}` : `Kept ${spec.path} (already exists)`);
  }

  const filesDir = devStorageRoot(repoRoot);
  const copied = ensureDevFiles(devSeedDir(repoRoot), filesDir, reset);
  console.log(copied ? `Copied the dev files to ${filesDir}` : `Kept ${filesDir}`);
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main();
}
