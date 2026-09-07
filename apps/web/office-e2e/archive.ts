import { utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "./process";

/** Store every ZIP member uncompressed so equal-length edits preserve archive size. */
export async function rewriteArchive(
  directory: string,
  bytes: Uint8Array,
  from: string,
  to: string,
  modifiedSeconds: number,
): Promise<string> {
  if (Buffer.byteLength(from) !== Buffer.byteLength(to))
    throw new Error("External edit markers must have equal byte length");
  const input = join(directory, "external-input.zip");
  const output = join(directory, "external-output.zip");
  await writeFile(input, bytes);
  await run("python3", [
    "-c",
    "import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as source, zipfile.ZipFile(sys.argv[2],'w',compression=zipfile.ZIP_STORED) as target:\n for name in sorted(source.namelist()):\n  data=source.read(name)\n  if name.endswith('.xml'): data=data.replace(sys.argv[3].encode(),sys.argv[4].encode())\n  info=zipfile.ZipInfo(name,(2000,1,1,0,0,0))\n  target.writestr(info,data)",
    input,
    output,
    from,
    to,
  ]);
  await utimes(output, modifiedSeconds, modifiedSeconds);
  return output;
}
