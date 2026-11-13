/**
 * Generates the dev-only files under `deploy/dev/files/**`, one folder per
 * user: the seed `pnpm dev:env` copies into the gitignored
 * `deploy/dev/.data/files` the api dev server serves (`FDRIVE_STORAGE_ROOT`
 * in apps/api/.env.dev). Run with `pnpm dev:seed`; the output is committed so
 * a fresh clone has dev fixtures without needing to run this script first.
 * `pnpm dev:users` creates the matching users.
 *
 * Reuses @fdrive/testkit's SEED_USERS/SEED_FILES so the dev environment has
 * the same alice, bob, and carol fixtures the automated tests use, plus a
 * fourth "dev" user with a few sample files meant to look nice in a browser.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SEED_FILES, SEED_USERS } from "@fdrive/testkit";
import { encodeMinimalPdf } from "./pdf.js";
import { encodePng } from "./png.js";

/** A dev user: a home folder under `deploy/dev/files` and a known password. */
export interface DevUser {
  readonly username: string;
  readonly password: string;
}

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

/** The dev-only user, meant for exploring the app in a browser. */
export const DEV_USER: DevUser = { username: "dev", password: "dev" };

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
 * sample files. Only a user's username and password are kept, and only
 * files owned by a user. Pure: takes the shared seed data as arguments so
 * it can be tested without importing the real testkit module.
 */
export function buildDevSeed(
  sharedUsers: readonly DevUser[],
  sharedFiles: Readonly<Record<string, Record<string, string>>>,
  devUser: DevUser,
  devFiles: Readonly<Record<string, string>>,
): {
  users: readonly DevUser[];
  files: Record<string, Record<string, string>>;
} {
  const users = [...sharedUsers, devUser].map(({ username, password }) => ({ username, password }));
  const names = new Set(users.map((user) => user.username));
  const files = Object.fromEntries(
    Object.entries(sharedFiles).filter(([owner]) => names.has(owner)),
  );
  return { users, files: { ...files, [devUser.username]: { ...devFiles } } };
}

/** Every dev user with its password, for `pnpm dev:users`. */
export function devUsers(): readonly DevUser[] {
  return buildDevSeed(SEED_USERS, SEED_FILES, DEV_USER, {}).users;
}

/**
 * Lays the seed files out under the files folder: each owner's virtual paths
 * below a folder named after them, as `<owner>/<path>`.
 */
export function devFileLayout(
  files: Readonly<Record<string, Record<string, string>>>,
): Array<{ path: string; content: string }> {
  return Object.entries(files).flatMap(([owner, byPath]) =>
    Object.entries(byPath).map(([path, content]) => ({
      path: `${owner}/${path.replace(/^\/+/, "")}`,
      content,
    })),
  );
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
  const filesDir = join(scriptDir, "..", "..", "deploy", "dev", "files");

  const { users, files } = buildDevSeed(SEED_USERS, SEED_FILES, DEV_USER, buildDevSampleFiles());
  const seededFiles = devFileLayout(files);
  for (const { path, content } of seededFiles) {
    writeSeedFile(join(filesDir, path), content);
  }

  console.log(
    `Wrote ${seededFiles.length} file(s) under ${filesDir} for users: ${users.map((u) => u.username).join(", ")}`,
  );
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main();
}
