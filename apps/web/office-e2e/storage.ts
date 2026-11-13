import { readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "./process";
import type { OfficeFixtureState } from "./state";

/** The user whose files the Office specs create and check. */
const OWNER = "alice";

/**
 * Where `path` in alice's files is on the host: the fixture's local folder
 * holds one home per user at `<storageRoot>/<username>`. Only canonical
 * absolute paths are accepted, so nothing reaches outside the home.
 */
export function storedPath(state: Pick<OfficeFixtureState, "storageRoot">, path: string): string {
  const segments = path.split("/").slice(1);
  if (
    !path.startsWith("/") ||
    /[\r\n\0\\]/.test(path) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  )
    throw new Error(`Invalid fixture path: ${JSON.stringify(path)}`);
  return join(state.storageRoot, OWNER, ...segments);
}

export async function storedBytes(
  state: Pick<OfficeFixtureState, "storageRoot">,
  path: string,
): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(storedPath(state, path)));
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT")
      throw new Error(`Stored file missing: ${path}`);
    throw error;
  }
}

export async function storedXml(state: OfficeFixtureState, path: string): Promise<string> {
  return storedContents(state, path, false);
}

/** Compare saved text across legitimate inline formatting and coauthor run boundaries. */
export async function storedText(state: OfficeFixtureState, path: string): Promise<string> {
  return storedContents(state, path, true);
}

async function storedContents(
  state: OfficeFixtureState,
  path: string,
  textOnly: boolean,
): Promise<string> {
  const bytes = await storedBytes(state, path);
  if (bytes.length === 0) return "";
  const archive = join(state.directory, `download-${process.pid}.zip`);
  await writeFile(archive, bytes);
  return run("python3", [
    "-c",
    "import sys,zipfile,xml.etree.ElementTree as ET\nwith zipfile.ZipFile(sys.argv[1]) as z:\n parts=[z.read(n).decode('utf-8') for n in z.namelist() if n == 'content.xml' or n == 'word/document.xml' or n == 'xl/sharedStrings.xml' or n.startswith('xl/worksheets/') and n.endswith('.xml') or n.startswith('ppt/slides/slide') and n.endswith('.xml')]\n print('\\n'.join(''.join(ET.fromstring(x).itertext()) if sys.argv[2] == 'text' else x for x in parts))",
    archive,
    textOnly ? "text" : "xml",
  ]);
}

/**
 * Writes `localPath` over `remotePath` in alice's files the way a writer
 * outside fdrive would (the host, rsync, OCR): in place, with the local
 * file's modification time kept, as `sftp put -p` did.
 */
export async function putExternally(
  state: Pick<OfficeFixtureState, "storageRoot">,
  localPath: string,
  remotePath: string,
): Promise<void> {
  const target = storedPath(state, remotePath);
  const source = await stat(localPath);
  await writeFile(target, await readFile(localPath));
  await utimes(target, source.atime, source.mtime);
}

/** The stored file's size and modification time, to whole seconds as HTTP and WOPI report it. */
export async function storedMetadata(
  state: Pick<OfficeFixtureState, "storageRoot">,
  path: string,
): Promise<{ size: number; modifiedSeconds: number }> {
  const metadata = await stat(storedPath(state, path));
  if (!metadata.isFile()) throw new Error("Storage metadata unavailable");
  return { size: metadata.size, modifiedSeconds: Math.floor(metadata.mtimeMs / 1000) };
}
