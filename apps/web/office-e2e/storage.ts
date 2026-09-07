import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run, runWithInput } from "./process";
import type { OfficeFixtureState } from "./state";

export async function storageToken(
  state: OfficeFixtureState,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const response = await fetcher(`${state.sftpgoUrl}/api/v2/user/token`, {
    headers: { Authorization: `Basic ${Buffer.from("alice:alice-password").toString("base64")}` },
  });
  if (!response.ok) throw new Error(`Storage login failed: ${response.status}`);
  return ((await response.json()) as { access_token: string }).access_token;
}

export async function storedBytes(
  state: OfficeFixtureState,
  path: string,
  fetcher: typeof fetch = fetch,
): Promise<Uint8Array> {
  const token = await storageToken(state, fetcher);
  const response = await fetcher(
    `${state.sftpgoUrl}/api/v2/user/files?path=${encodeURIComponent(path)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  if (!response.ok) throw new Error(`Storage download failed: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function storedXml(
  state: OfficeFixtureState,
  path: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  return storedContents(state, path, false, fetcher);
}

/** Compare saved text across legitimate inline formatting and coauthor run boundaries. */
export async function storedText(
  state: OfficeFixtureState,
  path: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  return storedContents(state, path, true, fetcher);
}

async function storedContents(
  state: OfficeFixtureState,
  path: string,
  textOnly: boolean,
  fetcher: typeof fetch,
): Promise<string> {
  const bytes = await storedBytes(state, path, fetcher);
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

export function sftpQuote(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("Invalid SFTP fixture filename");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function sftpArgs(state: OfficeFixtureState): string[] {
  if (!/^[a-f0-9]{12,64}$/.test(state.sftpgoContainer))
    throw new Error("Invalid fixture container");
  return [
    "-q",
    "-b",
    "-",
    "-P",
    "2022",
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    `IdentityFile=${join(state.directory, "sftp-key")}`,
    "-o",
    `UserKnownHostsFile=${join(state.directory, "known_hosts")}`,
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    `ProxyCommand=docker exec -i ${state.sftpgoContainer} bash -c 'exec 3<>/dev/tcp/127.0.0.1/2022; cat <&3 & cat >&3'`,
    `alice@fixture-${state.sftpgoContainer}`,
  ];
}

export async function putOverSftp(
  state: OfficeFixtureState,
  localPath: string,
  remotePath: string,
  execute: typeof runWithInput = runWithInput,
): Promise<void> {
  await execute(
    "sftp",
    sftpArgs(state),
    `put -p ${sftpQuote(localPath)} ${sftpQuote(remotePath)}\n`,
  );
}

export async function storedMetadata(
  state: OfficeFixtureState,
  path: string,
  fetcher: typeof fetch = fetch,
): Promise<{ size: number; modified: string }> {
  const token = await storageToken(state, fetcher);
  const response = await fetcher(
    `${state.sftpgoUrl}/api/v2/user/files?path=${encodeURIComponent(path)}`,
    { method: "HEAD", headers: { Authorization: `Bearer ${token}` } },
  );
  const size = response.headers.get("content-length");
  const modified = response.headers.get("last-modified");
  if (!response.ok || size === null || modified === null)
    throw new Error("Storage metadata unavailable");
  return { size: Number(size), modified };
}
