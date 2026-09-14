import type { Readable } from "node:stream";
import type { Pool, PoolClient } from "pg";

export interface SecretCodec {
  seal(bytes: Uint8Array, context: string): Uint8Array;
  open(bytes: Uint8Array, context: string): Uint8Array;
}
export interface BlobSource {
  kind: "attachment" | "desktop" | "ocr" | "logs" | "office" | "remote";
  path: string;
  size: number;
  identityId?: string | undefined;
  sourceId?: string | undefined;
  open(): Promise<Readable>;
}
export interface BlobRecord extends Omit<BlobSource, "open"> {
  entry: string;
  sha256: string;
}
export interface Column {
  name: string;
  type: string;
  generated: boolean;
}
export interface SnapshotHeader {
  format: 1;
  id: string;
  installationId: string;
  createdAt: string;
  masterKey: string;
  migrations: string[];
  schema: Record<string, Column[]>;
  fingerprint: string;
  environment: Record<string, unknown>;
}
export interface SnapshotManifest {
  format: 1;
  id: string;
  tables: Record<string, { rows: number; sha256: string }>;
  blobs: BlobRecord[];
  coverage: string[];
}
export interface BackupSource {
  pool: Pool;
  masterKey: string;
  environment: Record<string, unknown>;
  /** Called under the exclusive checkpoint and the database snapshot. */
  blobs(
    client: PoolClient,
    metadataOnly?: boolean,
  ): Promise<{ sources: BlobSource[]; coverage: string[] }>;
}
export interface ObjectInformation {
  versionId?: string;
  retentionUntil?: string;
  versioning?: string;
}
export interface BackupDestination {
  information(key: string): Promise<ObjectInformation | null>;
  put(key: string, file: string, signal?: AbortSignal): Promise<{ versionId?: string }>;
  get(key: string, versionId?: string): Promise<Readable>;
  list(): Promise<string[]>;
  remove(key: string, versionId?: string): Promise<void>;
}
