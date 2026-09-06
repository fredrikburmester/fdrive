/**
 * Narrow interfaces over the DOM's drag-and-drop and file-system-entry APIs
 * so this module can be unit tested with plain object fakes instead of a
 * real `DataTransfer`. They are structurally compatible with the real DOM
 * types (a real `DataTransfer` and its entries satisfy these shapes).
 */

export interface EntryLike {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  file?(success: (file: File) => void, error?: (err: unknown) => void): void;
  createReader?(): EntryReaderLike;
}

export interface EntryReaderLike {
  readEntries(success: (entries: EntryLike[]) => void, error?: (err: unknown) => void): void;
}

export interface DataTransferItemLike {
  readonly kind: string;
  webkitGetAsEntry?(): EntryLike | null;
  getAsFile?(): File | null;
}

export interface DataTransferLike {
  readonly items?: ArrayLike<DataTransferItemLike>;
  readonly files: ArrayLike<File>;
}

/** One file discovered by traversal, paired with its path relative to the drop root. */
export interface DroppedFile {
  readonly file: File;
  readonly relativePath: string;
}

const IGNORED_NAMES: ReadonlySet<string> = new Set([".DS_Store", "Thumbs.db"]);

function readEntryAsFile(entry: EntryLike): Promise<File> {
  return new Promise((resolve, reject) => {
    if (entry.file === undefined) {
      reject(new Error(`entry "${entry.name}" does not support file()`));
      return;
    }
    entry.file(resolve, reject);
  });
}

/**
 * Reads every batch from a directory reader until an empty batch is
 * returned, since Chrome caps `readEntries` at 100 results per call.
 */
async function readAllEntries(reader: EntryReaderLike): Promise<EntryLike[]> {
  const all: EntryLike[] = [];
  for (;;) {
    const batch = await new Promise<EntryLike[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (batch.length === 0) {
      break;
    }
    all.push(...batch);
  }
  return all;
}

async function walkEntry(entry: EntryLike, prefix: string, out: DroppedFile[]): Promise<void> {
  if (IGNORED_NAMES.has(entry.name)) {
    return;
  }
  const relativePath = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;

  if (entry.isFile) {
    const file = await readEntryAsFile(entry);
    out.push({ file, relativePath });
    return;
  }

  if (entry.isDirectory && entry.createReader !== undefined) {
    const reader = entry.createReader();
    const children = await readAllEntries(reader);
    for (const child of children) {
      await walkEntry(child, relativePath, out);
    }
  }
}

function supportsEntries(items: ArrayLike<DataTransferItemLike>): boolean {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item !== undefined && typeof item.webkitGetAsEntry === "function") {
      return true;
    }
  }
  return false;
}

function collectFromFileList(files: ArrayLike<File>): DroppedFile[] {
  const result: DroppedFile[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (file !== undefined && !IGNORED_NAMES.has(file.name)) {
      result.push({ file, relativePath: file.name });
    }
  }
  return result;
}

/**
 * Collects every file dropped onto the page, walking directory entries
 * recursively via `webkitGetAsEntry`. Falls back to the flat `files` list
 * (no folder structure) when the browser does not expose entries. Skips
 * `.DS_Store` and `Thumbs.db` at any depth.
 */
export async function collectDroppedFiles(dataTransfer: DataTransferLike): Promise<DroppedFile[]> {
  const items = dataTransfer.items;
  if (items === undefined || items.length === 0 || !supportsEntries(items)) {
    return collectFromFileList(dataTransfer.files);
  }

  const out: DroppedFile[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item === undefined || item.kind !== "file" || item.webkitGetAsEntry === undefined) {
      continue;
    }
    const entry = item.webkitGetAsEntry();
    if (entry === null) {
      continue;
    }
    await walkEntry(entry, "", out);
  }
  return out;
}

/**
 * A `File` as produced by an `<input webkitdirectory>` picker, whose
 * non-standard `webkitRelativePath` carries the folder structure.
 */
type FileWithRelativePath = File & { readonly webkitRelativePath?: string };

/**
 * Maps a `FileList`-like collection (from an `<input>` element) to
 * `DroppedFile`s, using `webkitRelativePath` for folder structure when
 * present and falling back to the bare file name otherwise. Skips
 * `.DS_Store` and `Thumbs.db`.
 */
export function collectInputFiles(fileList: ArrayLike<File>): DroppedFile[] {
  const result: DroppedFile[] = [];
  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i];
    if (file === undefined || IGNORED_NAMES.has(file.name)) {
      continue;
    }
    const withPath = file as FileWithRelativePath;
    const relativePath =
      withPath.webkitRelativePath !== undefined && withPath.webkitRelativePath.length > 0
        ? withPath.webkitRelativePath
        : file.name;
    result.push({ file, relativePath });
  }
  return result;
}
