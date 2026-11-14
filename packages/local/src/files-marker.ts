import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StorageError } from "@fdrive/core";
import { codeOf } from "./errors.js";

/**
 * The file at the top of the files folder that names the installation it
 * belongs to. Usernames start with a letter or digit, so it never shares a
 * name with a home. The indexer reads the same file before it scans.
 */
export const FILES_MARKER = ".fdrive-files";

/**
 * What the database says about the folder: the installation's id, which
 * the marker holds, and whether fdrive already has users or indexed files,
 * which an empty folder could not be the home of.
 */
export interface FilesFolderFacts {
  installationId(): Promise<string>;
  holdsFiles(): Promise<boolean>;
}

export type FilesFolderVerdict =
  | { readonly ok: true; readonly adopted: boolean }
  | { readonly ok: false; readonly reason: string };

export const FILES_FOLDER_REASONS = {
  missing: "The files folder is missing. Check FDRIVE_FILES_DIR.",
  unreadable:
    "fdrive cannot read the files folder or its .fdrive-files marker. Check FDRIVE_FILES_DIR and FDRIVE_RUN_AS_UID.",
  unwritable:
    "fdrive cannot write the .fdrive-files marker into the files folder. Check that FDRIVE_RUN_AS_UID can write it.",
  empty:
    "The files folder is empty and has no .fdrive-files marker, but fdrive already has users or indexed files. Check FDRIVE_FILES_DIR. If this really is the right folder, create an empty .fdrive-files file in it.",
  foreign:
    "The files folder belongs to another fdrive installation: its .fdrive-files marker names another one. Check FDRIVE_FILES_DIR. To take the folder over, delete the marker.",
  unchecked: "fdrive has not checked the files folder yet.",
  database: "fdrive cannot check the files folder: the database is unavailable.",
} as const;

function refuse(reason: string): FilesFolderVerdict {
  return { ok: false, reason };
}

/** The marker's text, trimmed; `null` when there is none. */
async function readMarker(root: string): Promise<string | null> {
  try {
    return (await readFile(join(root, FILES_MARKER), "utf8")).trim();
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    throw error;
  }
}

/**
 * Writes `id` as the marker. Only an absent marker is created (`wx`), so
 * two processes adopting at once agree; `replace` overwrites the empty
 * marker an administrator made to ask for adoption.
 */
async function writeMarker(root: string, id: string, replace: boolean): Promise<boolean> {
  try {
    await writeFile(join(root, FILES_MARKER), `${id}\n`, {
      flag: replace ? "w" : "wx",
      mode: 0o644,
    });
    return true;
  } catch (error) {
    if (!replace && codeOf(error) === "EEXIST") return (await readMarker(root)) === id;
    return false;
  }
}

/**
 * Decides whether fdrive may use `root` as its files folder, adopting it
 * when that is safe:
 *
 * - a marker naming this installation: yes;
 * - a marker naming another one: no, the folder is someone else's;
 * - an empty marker: an administrator asked to adopt the folder;
 * - no marker: adopt a folder that has anything in it, or any folder on an
 *   installation with no users or indexed files yet. An empty folder on an
 *   installation that has them is a wrong mount, such as Compose's empty
 *   default when `FDRIVE_FILES_DIR` is unset, and is refused rather than
 *   read as every file deleted.
 */
export async function verifyFilesFolder(
  root: string,
  facts: FilesFolderFacts,
): Promise<FilesFolderVerdict> {
  let id: string;
  try {
    id = await facts.installationId();
  } catch {
    return refuse(FILES_FOLDER_REASONS.database);
  }
  let marker: string | null;
  let entries: string[];
  try {
    if (!(await stat(root)).isDirectory()) return refuse(FILES_FOLDER_REASONS.missing);
    marker = await readMarker(root);
    entries = marker === null ? await readdir(root) : [];
  } catch (error) {
    return refuse(
      codeOf(error) === "ENOENT" ? FILES_FOLDER_REASONS.missing : FILES_FOLDER_REASONS.unreadable,
    );
  }
  if (marker === id) return { ok: true, adopted: false };
  if (marker !== null && marker !== "") return refuse(FILES_FOLDER_REASONS.foreign);
  if (marker === null && entries.length === 0) {
    let holds: boolean;
    try {
      holds = await facts.holdsFiles();
    } catch {
      return refuse(FILES_FOLDER_REASONS.database);
    }
    if (holds) return refuse(FILES_FOLDER_REASONS.empty);
  }
  return (await writeMarker(root, id, marker === ""))
    ? { ok: true, adopted: true }
    : refuse(FILES_FOLDER_REASONS.unwritable);
}

/**
 * Keeps the verdict on the files folder current. `verify` checks again once
 * the last check is older than `recheckMs` (one check at a time), so fixing
 * the folder takes effect without a restart; `refusal` answers from the
 * last check, and refuses until there has been one.
 */
export interface FilesFolderGuard {
  verify(): Promise<FilesFolderVerdict>;
  /** The reason fdrive may not use the folder now, or `null` when it may. */
  refusal(): string | null;
  /** Throws `StorageError` `upstream_unavailable` with the reason when fdrive may not use the folder. */
  assertUsable(): void;
}

export interface FilesFolderGuardOptions {
  readonly root: string;
  readonly facts: FilesFolderFacts;
  readonly recheckMs?: number;
  readonly now?: () => number;
  /** Hears each verdict that differs from the one before, including the first. */
  readonly onChange?: (verdict: FilesFolderVerdict) => void;
}

const DEFAULT_RECHECK_MS = 10_000;

export function createFilesFolderGuard(options: FilesFolderGuardOptions): FilesFolderGuard {
  const now = options.now ?? Date.now;
  const recheckMs = options.recheckMs ?? DEFAULT_RECHECK_MS;
  let current: FilesFolderVerdict | null = null;
  let checkedAt = 0;
  let running: Promise<FilesFolderVerdict> | null = null;

  const describe = (verdict: FilesFolderVerdict | null) =>
    verdict === null ? null : verdict.ok ? "ok" : verdict.reason;

  async function check(): Promise<FilesFolderVerdict> {
    const verdict = await verifyFilesFolder(options.root, options.facts);
    // A database blip does not take away a folder already verified.
    const next =
      !verdict.ok && verdict.reason === FILES_FOLDER_REASONS.database && current?.ok === true
        ? current
        : verdict;
    if (describe(next) !== describe(current) || (next.ok && next.adopted)) {
      options.onChange?.(next);
    }
    current = next.ok ? { ok: true, adopted: false } : next;
    checkedAt = now();
    return next;
  }

  function refusal(): string | null {
    if (current === null) return FILES_FOLDER_REASONS.unchecked;
    return current.ok ? null : current.reason;
  }

  return {
    verify() {
      if (current !== null && now() - checkedAt < recheckMs) return Promise.resolve(current);
      running ??= check().finally(() => {
        running = null;
      });
      return running;
    },
    refusal,
    assertUsable() {
      const reason = refusal();
      if (reason !== null) throw new StorageError("upstream_unavailable", reason);
    },
  };
}
