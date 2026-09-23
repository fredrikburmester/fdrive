import { z } from "zod";
import { CanonicalUuid } from "./canonical-uuid.ts";

export const PersonalActivityAction = z.enum([
  "file.upload",
  "file.create",
  "file.save",
  "folder.create",
  "file.rename",
  "file.move",
  "file.copy",
  "file.trash",
  "file.restore",
  "file.delete",
  "trash.empty",
  "file.open",
  "file.preview",
  "file.inspect",
  "file.read",
  "file.download",
  "file.materialize",
  "file.reveal",
  "archive.inspect",
  "archive.compress",
  "archive.extract",
  "share.create",
  "share.update",
  "share.revoke",
  "share.copy_link",
  "file.tags.set",
  "tag.update",
  "tag.delete",
  "file.favorite.set",
  "folder.view.set",
  "folder.view.reset",
  "observation.location_missing",
  "observation.location_changed",
  "observation.left_scope",
  "observation.content_changed",
  "observation.continuity_unknown",
  "observation.resolved",
]);
export type PersonalActivityAction = z.infer<typeof PersonalActivityAction>;
export const PersonalActivitySource = z.enum([
  "web",
  "api",
  // The account acting through an approved AI proposal, not an autonomous actor.
  "ai",
  "office",
  "mcp",
  "native",
  "indexer",
  "refresh",
]);
export const PersonalActivityOutcome = z.enum([
  "success",
  "failed",
  "denied",
  "cancelled",
  "skipped",
  "conflict",
  "partial",
  "unknown",
]);
export const PersonalActivityEvidence = z.enum([
  "server_confirmed",
  "client_reported",
  "watcher_move",
  "watcher_change",
  "sha256_relink",
  "provider_version",
  "refresh_comparison",
  "reconciled",
]);
export type PersonalActivitySource = z.infer<typeof PersonalActivitySource>;
export type PersonalActivityOutcome = z.infer<typeof PersonalActivityOutcome>;
export type PersonalActivityEvidence = z.infer<typeof PersonalActivityEvidence>;

const virtualPath = z.string().min(1).max(4096).startsWith("/");
const instant = z.iso.datetime({ offset: true });
/** Explicit allowlist: no content, cookies, provider credentials, or secret share URLs. */
export const ActivityFacts = z
  .object({
    path: virtualPath.optional(),
    targetPath: virtualPath.optional(),
    kind: z.enum(["file", "dir"]).optional(),
    size: z.number().nonnegative().optional(),
    modifiedAt: instant.nullable().optional(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    version: z.string().max(256).optional(),
    variant: z.enum(["duplicate", "save_as", "stored", "stream", "all", "single"]).optional(),
    trashLeaf: virtualPath.optional(),
    trashStrategy: z.enum(["sftpgo_rule", "fdrive_move"]).optional(),
    favorite: z.boolean().optional(),
    tags: z
      .array(
        z
          .object({
            id: CanonicalUuid,
            name: z.string().max(128),
            color: z.string().max(64).nullable(),
          })
          .strict(),
      )
      .max(100)
      .optional(),
    view: z.enum(["list", "grid", "tree", "auto"]).optional(),
    shareId: CanonicalUuid.optional(),
    expiresAt: instant.nullable().optional(),
    permissions: z.array(z.string().max(40)).max(16).optional(),
    observationId: CanonicalUuid.optional(),
    /** The chat that proposed this command, when the person applied an AI action. */
    conversationId: CanonicalUuid.optional(),
    reason: z
      .enum([
        "missing",
        "left_scope",
        "revision_changed",
        "ambiguous",
        "unpaired",
        "recovered",
        "interrupted",
        "history_pending",
      ])
      .optional(),
    completedCount: z.number().int().nonnegative().optional(),
    failedCount: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ActivityFacts = z.infer<typeof ActivityFacts>;

export const ActivitySubject = z.object({
  fileId: CanonicalUuid.nullable(),
  identityId: CanonicalUuid,
  role: z.enum(["primary", "source", "target", "affected"]),
  ordinal: z.number().int().nonnegative(),
  path: virtualPath.nullable(),
  revisionId: CanonicalUuid.nullable(),
});
export type ActivitySubject = z.infer<typeof ActivitySubject>;
export const ActivitySubjectsResponse = z.object({
  items: z.array(ActivitySubject).max(100),
  nextCursor: z.string().nullable(),
});
export const PersonalActivityEvent = z.object({
  schemaVersion: z.literal(1).default(1),
  id: CanonicalUuid,
  sequence: z.string().regex(/^\d+$/),
  identityId: CanonicalUuid,
  actorAccountId: CanonicalUuid.nullable(),
  fileId: CanonicalUuid.nullable(),
  action: PersonalActivityAction,
  class: z.enum(["action", "observation"]),
  stage: z.enum(["intent", "outcome", "reconciliation"]),
  outcome: PersonalActivityOutcome.nullable(),
  source: PersonalActivitySource,
  evidence: PersonalActivityEvidence,
  operationId: CanonicalUuid.nullable(),
  batchId: CanonicalUuid.nullable(),
  parentEventId: CanonicalUuid.nullable(),
  occurredAt: instant.nullable(),
  recordedAt: instant,
  sortAt: instant,
  lastConfirmedAt: instant.nullable(),
  detectedAt: instant.nullable(),
  before: ActivityFacts.nullable(),
  after: ActivityFacts.nullable(),
  detail: ActivityFacts.nullable(),
  errorCode: z.string().max(64).nullable(),
  count: z.number().int().positive(),
  firstAt: instant.nullable(),
  lastAt: instant.nullable(),
  outcomeCounts: z
    .partialRecord(PersonalActivityOutcome, z.number().int().nonnegative())
    .nullable(),
  subjects: z.array(ActivitySubject).max(100),
  subjectsTruncated: z.boolean(),
  provisional: z.boolean().default(false),
});
export type PersonalActivityEvent = z.infer<typeof PersonalActivityEvent>;
export const PersonalActivityFilters = z
  .object({
    identityId: CanonicalUuid.optional(),
    action: PersonalActivityAction.optional(),
    source: PersonalActivitySource.optional(),
    outcome: PersonalActivityOutcome.optional(),
    from: instant.optional(),
    to: instant.optional(),
    q: z.string().max(256).optional(),
    cursor: z.string().max(4096).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export type PersonalActivityFilters = z.infer<typeof PersonalActivityFilters>;
export const ActivityBatchSummary = z.object({
  total: z.number().int().nonnegative(),
  outcomes: z.partialRecord(
    z.enum([...PersonalActivityOutcome.options, "pending"]),
    z.number().int().nonnegative(),
  ),
});
export const PersonalActivityResponse = z.object({
  items: z.array(PersonalActivityEvent),
  nextCursor: z.string().nullable(),
  provisionalReads: z.array(PersonalActivityEvent).max(100).default([]),
  historyStartsAt: instant.nullable(),
  retainedFrom: instant.nullable(),
  batchSummary: ActivityBatchSummary.optional(),
  coverage: z.object({
    mutations: z.boolean(),
    reads: z.boolean(),
    observations: z.enum(["watcher_and_refresh", "refresh", "unavailable"]),
    observationGap: z.boolean(),
  }),
});
export type PersonalActivityResponse = z.infer<typeof PersonalActivityResponse>;

export const ClientActivityRequest = z
  .object({
    identityId: CanonicalUuid,
    requestId: CanonicalUuid,
    at: instant,
    action: z.enum([
      "file.open",
      "file.preview",
      "file.inspect",
      "file.reveal",
      "archive.inspect",
      "share.copy_link",
    ]),
    path: virtualPath,
    shareId: CanonicalUuid.optional(),
  })
  .strict();
export type ClientActivityRequest = z.infer<typeof ClientActivityRequest>;
export const ActivityFileResponse = z.object({
  id: CanonicalUuid,
  identityId: CanonicalUuid,
  label: z.string(),
  kind: z.enum(["file", "dir"]),
  lastKnownPath: virtualPath,
  currentPath: virtualPath.nullable(),
  availability: z.enum(["live", "trashed", "deleted", "unknown", "unavailable"]),
  lastConfirmedAt: instant.nullable(),
  revisionId: CanonicalUuid.nullable(),
});
export type ActivityFileResponse = z.infer<typeof ActivityFileResponse>;

export const ActivityLineageResponse = z.object({
  items: z.array(
    z.object({
      id: CanonicalUuid,
      kind: z.string(),
      sourceFileId: CanonicalUuid,
      targetFileId: CanonicalUuid,
      sourcePath: virtualPath.nullable().optional(),
      targetPath: virtualPath.nullable().optional(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export const ActivityRevisionsResponse = z.object({
  items: z.array(
    z.object({
      id: CanonicalUuid,
      eventId: CanonicalUuid,
      size: z.number().nullable(),
      sha256: z.string().nullable(),
      providerVersion: z.string().nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export const ActivityLocationsResponse = z.object({
  items: z.array(z.object({ identityId: CanonicalUuid, label: z.string() })),
});
