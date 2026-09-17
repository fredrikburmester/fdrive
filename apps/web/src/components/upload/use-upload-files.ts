"use client";

import { useCallback, useState } from "react";
import { planUploads } from "@/lib/upload/plan";
import { useUploadStore } from "@/lib/upload/store";
import type { DroppedFile } from "@/lib/upload/traverse";

function createUploadId(): string {
  return crypto.randomUUID();
}

interface PendingConflict {
  readonly identityId: string | undefined;
  readonly files: readonly DroppedFile[];
  readonly destination: string;
  readonly existingNames: ReadonlySet<string>;
  readonly conflicts: readonly string[];
}

export interface ConflictDialogState {
  readonly open: boolean;
  readonly conflicts: readonly string[];
  readonly onReplace: () => void;
  readonly onSkip: () => void;
  readonly onCancel: () => void;
}

export interface UseUploadFilesResult {
  /**
   * Plans `files` against `destination`, opening the conflict dialog when
   * needed and enqueuing the result on the upload store. The activity panel
   * is the only feedback: a toast would sit in the same bottom-right corner
   * and cover it. The single entry point the browser (drop zone, file
   * picker, paste) calls to start an upload.
   */
  uploadFiles(
    files: readonly DroppedFile[],
    destination: string,
    existingNames: ReadonlySet<string>,
  ): void;
  /** Wire this directly into `<ConflictDialog {...conflictDialog} />`. */
  readonly conflictDialog: ConflictDialogState;
}

export function useUploadFiles(): UseUploadFilesResult {
  const enqueue = useUploadStore((s) => s.enqueue);
  const [pending, setPending] = useState<PendingConflict | null>(null);

  const plan = useCallback(
    (
      files: readonly DroppedFile[],
      destination: string,
      existingNames: ReadonlySet<string>,
      policy: "replace" | "skip" | "ask",
      identityId: string | undefined,
    ) => {
      const result = planUploads(files, destination, existingNames, policy, createUploadId);

      if (policy === "ask" && result.conflicts.length > 0) {
        setPending({ files, destination, existingNames, conflicts: result.conflicts, identityId });
        return;
      }

      enqueue(
        result.items.map((item) => (identityId === undefined ? item : { ...item, identityId })),
      );
    },
    [enqueue],
  );

  const uploadFiles = useCallback(
    (files: readonly DroppedFile[], destination: string, existingNames: ReadonlySet<string>) => {
      if (files.length === 0) {
        return;
      }
      plan(files, destination, existingNames, "ask", useUploadStore.getState().activeIdentityId);
    },
    [plan],
  );

  const resolveConflict = useCallback(
    (policy: "replace" | "skip") => {
      if (pending === null) {
        return;
      }
      const { files, destination, existingNames, identityId } = pending;
      setPending(null);
      plan(files, destination, existingNames, policy, identityId);
    },
    [pending, plan],
  );

  const cancelConflict = useCallback(() => {
    setPending(null);
  }, []);

  return {
    uploadFiles,
    conflictDialog: {
      open: pending !== null,
      conflicts: pending?.conflicts ?? [],
      onReplace: () => resolveConflict("replace"),
      onSkip: () => resolveConflict("skip"),
      onCancel: cancelConflict,
    },
  };
}
