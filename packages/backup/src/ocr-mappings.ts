import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { PoolClient } from "pg";
import { bytesStream } from "./streams.js";
import type { BlobSource } from "./types.js";

/** Legacy OCR names contain a truncated source hash. Only an exact, unique log match resolves it. */
export async function legacyOcrMappings(
  client: PoolClient,
  root: string,
  blobs: BlobSource[],
): Promise<{ sources: BlobSource[]; coverage: string[] }> {
  const paths = new Set(blobs.map((blob) => blob.path));
  const sources: BlobSource[] = [];
  let unresolved = 0;
  for (const blob of blobs) {
    if (!blob.path.startsWith("originals/") || blob.path.slice(10).includes("/")) continue;
    const original = basename(blob.path);
    const path = `original-mappings/${original}.json`;
    if (paths.has(path)) continue;
    const metadata = await lstat(join(root, blob.path), { bigint: true });
    const candidates = (
      await client.query<{ root: string; path: string; mtime_ns: string }>(
        "select distinct r.name as root,l.path,l.mtime_ns::text from idx.ocr_log l join idx.roots r on r.id=l.root_id where l.mtime_ns=$1 and regexp_replace(l.path, '^.*/', '')=$2 limit 1001",
        [String(metadata.mtimeNs), original.slice(17)],
      )
    ).rows;
    const matches = candidates.filter((candidate) => {
      const hash = createHash("sha256")
        .update(`${candidate.root}:${candidate.path}:${metadata.size}:${candidate.mtime_ns}`)
        .digest("hex")
        .slice(0, 16);
      return `${hash}_${basename(candidate.path)}` === original;
    });
    const match = candidates.length <= 1000 && matches.length === 1 ? matches[0] : undefined;
    if (!match) unresolved++;
    // The archive manifest binds originalPath to its byte count and SHA-256; no source writes.
    const bytes = Buffer.from(
      JSON.stringify({
        version: 1,
        legacy: true,
        status: match ? "resolved" : "unresolved",
        root: match?.root ?? null,
        path: match?.path ?? null,
        size: blob.size,
        mtime_ns: String(metadata.mtimeNs),
        original,
        originalPath: blob.path,
        digestSource: "snapshot-manifest",
        candidatesTruncated: candidates.length > 1000,
      }),
    );
    sources.push({
      kind: "ocr",
      path,
      size: bytes.length,
      sourceId: blob.sourceId,
      open: async () => bytesStream(bytes),
    });
  }
  return {
    sources,
    coverage: unresolved
      ? [
          `${unresolved} legacy OCR original mapping(s) unresolved; bytes are preserved for manual recovery`,
        ]
      : [],
  };
}
