export interface FileVersionInput {
  readonly mtimeNs: bigint;
  readonly size: bigint;
  readonly sha256?: string;
}

export function deriveFileVersion({ mtimeNs, size, sha256 }: FileVersionInput): string {
  if (size < 0n) throw new Error("File size cannot be negative");
  if (sha256 !== undefined && !/^[a-fA-F0-9]{64}$/.test(sha256)) throw new Error("Invalid SHA-256");
  return `${mtimeNs}:${size}${sha256 === undefined ? "" : `:${sha256.slice(0, 16).toLowerCase()}`}`;
}
