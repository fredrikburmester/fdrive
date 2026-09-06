"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { planUploads } from "@/lib/upload/plan";
import { useUploadStore } from "@/lib/upload/store";
import type { DroppedFile } from "@/lib/upload/traverse";

function createUploadId(): string {
  return crypto.randomUUID();
}

interface PendingConflict {
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
   * needed, enqueuing the result on the upload store, and showing a toast
   * summary. The single entry point the browser (drop zone, file picker,
   * paste) calls to start an upload.
   */
  uploadFiles(
    files: readonly DroppedFile[],
    destination: string,
    existingNames: ReadonlySet<string>,
  ): void;
  /** Wire this directly into `<ConflictDialog {...conflictDialog} />`. */
  readonly conflictDialog: ConflictDialogState;
}

function summaryToast(destination: string, queued: number, skipped: number): void {
  if (queued > 0) {
    const description = skipped > 0 ? `${skipped} skipped: already exists` : undefined;
    toast.success(
      `Uploading ${queued} item${queued === 1 ? "" : "s"} to ${destination}`,
      description !== undefined ? { description } : undefined,
    );
    return;
  }
  if (skipped > 0) {
    toast.info(`Skipped ${skipped} item${skipped === 1 ? "" : "s"}: already exists`);
  }
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
    ) => {
      const result = planUploads(files, destination, existingNames, policy, createUploadId);

      if (policy === "ask" && result.conflicts.length > 0) {
        setPending({ files, destination, existingNames, conflicts: result.conflicts });
        return;
      }

      enqueue(result.items);
      const skipped = result.items.filter((item) => item.status === "skipped").length;
      summaryToast(destination, result.items.length - skipped, skipped);
    },
    [enqueue],
  );

  const uploadFiles = useCallback(
    (files: readonly DroppedFile[], destination: string, existingNames: ReadonlySet<string>) => {
      if (files.length === 0) {
        return;
      }
      plan(files, destination, existingNames, "ask");
    },
    [plan],
  );

  const resolveConflict = useCallback(
    (policy: "replace" | "skip") => {
      if (pending === null) {
        return;
      }
      const { files, destination, existingNames } = pending;
      setPending(null);
      plan(files, destination, existingNames, policy);
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
