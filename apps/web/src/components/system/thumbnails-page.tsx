"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Code } from "@/components/shell/sheet-data";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  useClearThumbnails,
  useRebuildIndexerThumbnails,
  useSystemIndexer,
  useSystemMaintenanceBusy,
  useSystemThumbnails,
} from "@/lib/api/system-queries";
import { describeMaintenanceError } from "@/lib/system/maintenance";
import { sidecarStatus } from "@/lib/system/status";
import { useFormatters } from "@/lib/use-format-preferences";
import { LogSheet } from "./log-sheet";
import { MaintenanceProgress } from "./maintenance-progress";
import { StatGrid } from "./stat-grid";
import { StatusBadge } from "./status-badge";
import { SystemErrorState } from "./system-error-state";
import { SystemPage } from "./system-page";
import { SystemLine, SystemNote } from "./system-section";

/**
 * Admin page: `System > Thumbnails`. The preview cache's size, rebuilding it and clearing it,
 * independent of text indexing.
 */
export function ThumbnailsPage() {
  const { formatBytes } = useFormatters();
  const { data, isLoading, error, dataUpdatedAt, refetch } = useSystemThumbnails();
  const indexer = useSystemIndexer();
  const rebuild = useRebuildIndexerThumbnails();
  const clear = useClearThumbnails();
  const busy =
    useSystemMaintenanceBusy(indexer.data?.stats) || rebuild.isPending || clear.isPending;
  const unavailable = !data?.configured || !indexer.data?.reachable || !!error || !!indexer.error;
  // The thumbnail cache is produced by the indexer, so the badge and the
  // note under it share one status computed from both FDRIVE_THUMBS_DIR
  // (`data.configured`) and the indexer's configured/reachable state,
  // rather than one signal saying "Reachable" while the other says
  // "Not configured". It is unknown until both have answered.
  const status =
    data === undefined || indexer.data === undefined
      ? null
      : sidecarStatus(data.configured && indexer.data.configured, indexer.data.reachable);
  const [rebuildOpen, setRebuildOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [path, setPath] = useState("");
  const [force, setForce] = useState(false);

  function handleRebuildConfirm() {
    rebuild.mutate(
      {
        ...(path.trim() ? { path: path.trim() } : {}),
        ...(force ? { force: true } : {}),
      },
      {
        onSuccess: (result) => {
          toast.success(
            result.total === null
              ? "Rebuild started. Discovering files…"
              : result.total > 0
                ? `Rebuilding ${result.total} thumbnail${result.total === 1 ? "" : "s"}…`
                : "No thumbnails need rebuilding.",
          );
          setRebuildOpen(false);
          setPath("");
          setForce(false);
        },
        onError: (err) => toast.error(describeMaintenanceError(err)),
      },
    );
  }

  function handleClearConfirm() {
    clear.mutate(undefined, {
      onSuccess: () => {
        toast.success("Thumbnail cache clear started.");
        setClearOpen(false);
      },
      onError: (err) => toast.error(describeMaintenanceError(err)),
    });
  }

  return (
    <SystemPage
      title="Thumbnails"
      description="Previews of images, PDFs and videos, kept in a cache on disk."
      lastUpdated={dataUpdatedAt > 0 ? new Date(dataUpdatedAt) : null}
      feature="thumbnails"
      badges={status === null || error ? null : <StatusBadge status={status} />}
      actions={
        <>
          <LogSheet subsystem="thumbnails" />
          <Button
            type="button"
            size="lg"
            disabled={unavailable || busy}
            onClick={() => setRebuildOpen(true)}
          >
            Rebuild
          </Button>
        </>
      }
      footer={
        <>
          <p className="min-w-0 flex-[1_1_16rem] text-muted-foreground">
            Clearing removes cached previews only. Your files are not touched.
          </p>
          <Button
            type="button"
            variant="destructive"
            size="lg"
            className="ml-auto sheet:px-2"
            disabled={unavailable || busy}
            onClick={() => setClearOpen(true)}
          >
            Clear thumbnails
          </Button>
        </>
      }
    >
      {isLoading ? (
        <SystemLine>Loading…</SystemLine>
      ) : error ? (
        <SystemErrorState error={error} onRetry={() => void refetch()} />
      ) : data === undefined ? null : (
        <>
          <MaintenanceProgress
            title="Thumbnail rebuild"
            job={indexer.data?.stats?.thumbnailRebuild}
          />
          <MaintenanceProgress
            title="Thumbnail cache clear"
            job={indexer.data?.stats?.thumbnailClear}
          />
          {status === "unreachable" || status === "not_configured" ? (
            <SystemNote>
              <p>
                {status === "unreachable" ? (
                  "The indexer that generates thumbnails is unreachable."
                ) : (
                  <>
                    Not configured: set <Code>FDRIVE_THUMBS_DIR</Code> and{" "}
                    <Code>FDRIVE_INDEXER_URL</Code>.
                  </>
                )}
              </p>
            </SystemNote>
          ) : null}
          {indexer.error ? (
            <SystemErrorState error={indexer.error} onRetry={() => void indexer.refetch()} />
          ) : null}
          <StatGrid
            stats={[
              { label: "Thumbnails", value: data.count.toLocaleString() },
              { label: "Cache size", value: formatBytes(data.bytes) },
            ]}
          />
        </>
      )}
      <Dialog open={rebuildOpen} onOpenChange={setRebuildOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rebuild thumbnails</DialogTitle>
            <DialogDescription>
              Regenerates preview images for photos, PDFs, and videos. Text and search data are not
              touched.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <Field>
              <FieldLabel htmlFor="rebuild-path">Path (optional)</FieldLabel>
              <Input
                id="rebuild-path"
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="Everything"
              />
              <FieldDescription>
                A file or folder in the files folder, such as alice/Photos.
              </FieldDescription>
            </Field>
            <Field orientation="horizontal">
              <FieldLabel htmlFor="rebuild-force">Regenerate existing thumbnails</FieldLabel>
              <Switch id="rebuild-force" checked={force} onCheckedChange={setForce} />
            </Field>
            <FieldDescription>
              Off fills missing previews; on replaces every preview in scope.
            </FieldDescription>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRebuildOpen(false)}>
              Cancel
            </Button>
            <Button type="button" disabled={unavailable || busy} onClick={handleRebuildConfirm}>
              Rebuild
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={clearOpen} onOpenChange={setClearOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Clear thumbnail cache?</DialogTitle>
            <DialogDescription>
              Removes every cached preview, including unused preview files. Original files,
              extracted text, embeddings, tags, favorites, and recents stay. Normal indexing or
              on-demand generation can create previews again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setClearOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={unavailable || busy}
              onClick={handleClearConfirm}
            >
              Clear thumbnails
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SystemPage>
  );
}
