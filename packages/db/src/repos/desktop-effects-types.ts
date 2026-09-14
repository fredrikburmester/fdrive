export interface DesktopEffectContext {
  from: string | null;
  to: string;
  directory: boolean;
  trash: boolean;
  office: { providerId: string; rootName: string; from: string; to: string | null } | null;
}

export interface EffectRevision {
  path: string;
  revision: string;
}
export interface EffectSnapshot {
  table: "file_tags" | "favorites" | "folder_views" | "recents" | "office_files";
  from: string;
  to: string | null;
  source: EffectRevision[];
  destination: EffectRevision[];
}
export interface DesktopEffectPayload extends DesktopEffectContext {
  snapshots: EffectSnapshot[];
  /** Metadata committed; only event delivery remains. */
  metadataApplied?: boolean;
  /** A later path mutation superseded this destination. Preserve snapshots for attention. */
  superseded?: boolean;
}

export interface DesktopEffectEvent {
  type: "fs";
  identityId: string;
  op: "create" | "mkdir" | "move" | "delete";
  paths: string[];
  targetPaths?: string[];
  at: string;
}

export interface DesktopEffectStatus {
  identityId: string;
  operationId: string;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  nextAttemptAt: Date;
}

export interface DesktopEffectsRepo {
  /** Applies metadata atomically, then delivers after commit; concurrent workers serialize. */
  processNext(
    publish: (event: DesktopEffectEvent) => void,
    identityId?: string,
  ): Promise<
    | { state: "idle" }
    | { state: "completed" | "retired"; identityId: string; operationId: string }
    | { state: "failed"; identityId: string; operationId: string; retryAt: Date }
  >;
  pending(identityId?: string): Promise<boolean>;
  status(): Promise<DesktopEffectStatus[]>;
}
