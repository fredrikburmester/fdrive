"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { describeApiError } from "@/lib/api/errors";
import { useRebuildThumbnails, useSystemThumbnails } from "@/lib/api/system-queries";
import { formatBytes } from "@/lib/format";
import { sidecarStatus } from "@/lib/system/status";
import { StatCard } from "./stat-card";
import { StatusBadge } from "./status-badge";
import { SystemErrorState } from "./system-error-state";
import { SystemPage } from "./system-page";

/** Admin page: `System > Thumbnails`. Cache size on disk and a rebuild action. */
export function ThumbnailsPage() {
  const { data, isLoading, error, dataUpdatedAt, refetch } = useSystemThumbnails();
  const rebuild = useRebuildThumbnails();
  const [rebuildOpen, setRebuildOpen] = useState(false);

  function handleRebuildConfirm() {
    rebuild.mutate(undefined, {
      onSuccess: (result) => {
        toast.success(
          `Marked ${result.marked} thumbnail${result.marked === 1 ? "" : "s"} to rebuild.`,
        );
        setRebuildOpen(false);
      },
      onError: (err) => toast.error(describeApiError(err)),
    });
  }

  return (
    <SystemPage
      title="Thumbnails"
      description="The indexer's on-disk thumbnail cache."
      lastUpdated={dataUpdatedAt > 0 ? new Date(dataUpdatedAt) : null}
      actions={
        <Button
          type="button"
          onClick={() => setRebuildOpen(true)}
          disabled={data === undefined || !data.configured}
        >
          Rebuild…
        </Button>
      }
    >
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : error ? (
        <SystemErrorState error={error} onRetry={() => void refetch()} />
      ) : data === undefined ? null : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Status</CardTitle>
              <CardDescription>
                {data.configured
                  ? "FDRIVE_THUMBS_DIR is configured."
                  : "FDRIVE_THUMBS_DIR is not set; thumbnails are disabled."}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <StatusBadge status={sidecarStatus(data.configured, data.configured)} />
              <p className="text-sm text-muted-foreground">
                Rebuild marks every file pending so the indexer regenerates any thumbnail missing on
                disk. Existing thumbnails are left as-is; there is no way to force a regenerate yet.
                Clearing the whole cache is not available yet. It is coming in a later release.
              </p>
            </CardContent>
          </Card>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-2">
            <StatCard label="Thumbnails" value={data.count.toLocaleString()} />
            <StatCard label="Cache size" value={formatBytes(data.bytes)} />
          </div>
        </>
      )}

      <AlertDialog open={rebuildOpen} onOpenChange={setRebuildOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rebuild every thumbnail?</AlertDialogTitle>
            <AlertDialogDescription>
              Marks every file pending so the indexer regenerates any thumbnail missing on disk.
              This can take a while for a large index.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={rebuild.isPending} onClick={handleRebuildConfirm}>
              Rebuild
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SystemPage>
  );
}
