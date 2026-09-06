/**
 * Creates apps/api/.env.dev and apps/web/.env.local if they do not already
 * exist, so `pnpm dev:env` gives a fresh clone a working local environment
 * without overwriting anything a developer has already customized. Both
 * files are gitignored (see the root and apps/web .gitignore, which ignore
 * `.env*` except `.env.example`).
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  writeFileSync(spec.path, spec.contents, "utf-8");
  return true;
}

function main(): void {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(scriptDir, "..", "..");

  const specs: EnvFileSpec[] = [
    {
      path: join(repoRoot, "apps", "api", ".env.dev"),
      contents: buildApiEnvDev(generateMasterKey()),
    },
    {
      path: join(repoRoot, "apps", "web", ".env.local"),
      contents: buildWebEnvLocal(),
    },
  ];

  for (const spec of specs) {
    const wrote = ensureEnvFile(spec);
    console.log(wrote ? `Created ${spec.path}` : `Skipped ${spec.path} (already exists)`);
  }
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main();
}
