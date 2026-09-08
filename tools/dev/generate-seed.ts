/**
 * Generates the dev-only SFTPGo seed data: `deploy/dev/sftpgo-seed.json`
 * (loaded by SFTPGo via SFTPGO_LOADDATA_FROM) and the files under
 * `deploy/dev/files/**` (copied into the SFTPGo data volume by the
 * `sftpgo-seed` one-shot compose service). Run with `pnpm dev:seed`; the
 * output is committed so a fresh clone has dev fixtures without needing to
 * run this script first.
 *
 * Reuses @fdrive/testkit's SEED_USERS/SEED_FOLDERS/SEED_FILES so the dev
 * environment has the same alice, bob, and carol fixtures the automated
 * tests use, plus a fourth "dev" user with full permissions and a few
 * sample files meant to look nice in a browser.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSftpgoDump,
  SEED_FILES,
  SEED_FOLDERS,
  SEED_USERS,
  type SeedUser,
  seedFileLayout,
} from "@fdrive/testkit";
import { encodeMinimalPdf } from "./pdf.js";
import { encodePng } from "./png.js";

/** Matches SFTPGO_DATA_DIR used by the testkit and by compose.dev.yaml's sftpgo volume. */
export const DEV_DATA_DIR = "/srv/sftpgo/data";

/** Seeded recycle rule path. Enable the matching Trash integration in fdrive's UI. */
export const DEV_TRASH_PATH = "/.trash";

const BASE64_PREFIX = "BASE64:";

function toBase64Marker(buffer: Buffer): string {
  return `${BASE64_PREFIX}${buffer.toString("base64")}`;
}

/**
 * Generates a small, cheerful 16x16 PNG (a blue-to-teal gradient) as raw
 * bytes, then wraps it in the BASE64: marker `writeSeedFile` understands.
 */
export function buildSamplePngMarker(): string {
  const size = 16;
  const png = encodePng(size, size, (x, y) => ({
    r: Math.round((x / (size - 1)) * 80),
    g: Math.round(120 + (y / (size - 1)) * 100),
    b: Math.round(160 + (x / (size - 1)) * 80),
  }));
  return toBase64Marker(png);
}

/**
 * Generates a 640x400 PNG gradient (a wider blue-to-orange sweep than
 * `buildSamplePngMarker`'s 16x16 thumbnail), large enough to exercise the
 * image preview viewer at a realistic size, wrapped in the BASE64: marker
 * `writeSeedFile` understands.
 */
export function buildGradientPngMarker(): string {
  const width = 640;
  const height = 400;
  const png = encodePng(width, height, (x, y) => ({
    r: Math.round((x / (width - 1)) * 255),
    g: Math.round(90 + (y / (height - 1)) * 120),
    b: Math.round(210 - (x / (width - 1)) * 130),
  }));
  return toBase64Marker(png);
}

/**
 * Generates a small, valid one-page PDF ("Hello, fdrive") for exercising the
 * PDF preview viewer, wrapped in the BASE64: marker `writeSeedFile`
 * understands.
 */
export function buildSamplePdfMarker(): string {
  return toBase64Marker(encodeMinimalPdf("Hello, fdrive sample PDF"));
}

/** The dev-only user: full permissions, meant for exploring the app in a browser. */
export const DEV_USER: SeedUser = {
  username: "dev",
  password: "dev",
  permissions: { "/": ["*"] },
};

/**
 * Builds the dev user's sample files, keyed the same way SEED_FILES is
 * (virtual path within the owner's home to file content). PNG content is
 * wrapped in a BASE64: marker that `writeSeedFile` decodes; everything else
 * is written as plain UTF-8 text.
 */
export function buildDevSampleFiles(): Record<string, string> {
  return {
    "/README.md":
      "# Welcome to fdrive\n\n" +
      "This is the dev account, seeded for local development. It has full\n" +
      "permissions on its home directory. Try uploading, downloading, and\n" +
      "organizing files here.\n",
    "/photo.png": buildSamplePngMarker(),
    "/gradient.png": buildGradientPngMarker(),
    "/budget.csv": "category,amount\nrent,1200\ngroceries,340\ntransit,60\n",
    "/notes/todo.md":
      "# Todo\n\n- [ ] Try renaming a file\n- [ ] Upload a folder\n- [ ] Preview a PDF\n",
    "/notes/ideas.md":
      "# Ideas\n\n" +
      "Random notes and ideas go here. This file exists so the markdown\n" +
      "preview and the file browser both have more than one document to show.\n",
    "/code/example.ts":
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal TypeScript source text for the seeded /code/example.ts file, not an accidental template placeholder
      "export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n",
    "/docs/sample.pdf": buildSamplePdfMarker(),
  };
}

/**
 * Merges the shared testkit seed users/files with the dev-only user and its
 * sample files. Pure: takes the shared seed data as arguments so it can be
 * tested without importing the real testkit module.
 */
export function buildDevSeed(
  sharedUsers: readonly SeedUser[],
  sharedFiles: Readonly<Record<string, Record<string, string>>>,
  devUser: SeedUser,
  devFiles: Readonly<Record<string, string>>,
): {
  users: readonly SeedUser[];
  files: Record<string, Record<string, string>>;
} {
  return {
    users: [...sharedUsers, devUser],
    files: { ...sharedFiles, [devUser.username]: { ...devFiles } },
  };
}

/**
 * Strips a seeded file's absolute container path down to a path relative to
 * `dataDir`, suitable for use under `deploy/dev/files/`. Throws if
 * `containerPath` is not actually under `dataDir`, which would indicate a
 * bug in the seed data rather than bad input.
 */
export function relativizeContainerPath(containerPath: string, dataDir: string): string {
  const prefix = `${dataDir}/`;
  if (!containerPath.startsWith(prefix)) {
    throw new Error(`expected "${containerPath}" to start with "${prefix}"`);
  }
  return containerPath.slice(prefix.length);
}

/**
 * Writes one seeded file's content to disk at `absoluteOutputPath`, creating
 * parent directories as needed. Content prefixed with BASE64: is decoded as
 * binary; everything else is written as UTF-8 text.
 */
export function writeSeedFile(absoluteOutputPath: string, content: string): void {
  mkdirSync(dirname(absoluteOutputPath), { recursive: true });

  if (content.startsWith(BASE64_PREFIX)) {
    writeFileSync(absoluteOutputPath, Buffer.from(content.slice(BASE64_PREFIX.length), "base64"));
    return;
  }

  writeFileSync(absoluteOutputPath, content, "utf-8");
}

function main(): void {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(scriptDir, "..", "..");
  const devDir = join(repoRoot, "deploy", "dev");
  const filesDir = join(devDir, "files");
  const seedJsonPath = join(devDir, "sftpgo-seed.json");

  const { users, files } = buildDevSeed(SEED_USERS, SEED_FILES, DEV_USER, buildDevSampleFiles());

  const dump = buildSftpgoDump(users, SEED_FOLDERS, {
    dataDir: DEV_DATA_DIR,
    trash: { path: DEV_TRASH_PATH },
  });
  mkdirSync(devDir, { recursive: true });
  writeFileSync(seedJsonPath, `${JSON.stringify(dump, null, 2)}\n`, "utf-8");

  const seededFiles = seedFileLayout(files, { dataDir: DEV_DATA_DIR });
  for (const { containerPath, content } of seededFiles) {
    const relativePath = relativizeContainerPath(containerPath, DEV_DATA_DIR);
    writeSeedFile(join(filesDir, relativePath), content);
  }

  // Re-format the generated JSON with biome so committed output always
  // matches the repository's formatting rules, regardless of how
  // JSON.stringify chose to lay it out.
  execFileSync("pnpm", ["exec", "biome", "check", "--write", seedJsonPath], {
    cwd: repoRoot,
    stdio: "ignore",
  });

  console.log(
    `Wrote ${seedJsonPath} and ${seededFiles.length} file(s) under ${filesDir} for users: ${users.map((u) => u.username).join(", ")}`,
  );
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main();
}
