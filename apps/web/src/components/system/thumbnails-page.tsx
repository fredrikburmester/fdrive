"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  useClearThumbnails,
  useRebuildIndexerThumbnails,
  useSystemIndexer,
  useSystemMaintenanceBusy,
  useSystemThumbnails,
} from "@/lib/api/system-queries";
import { formatBytes } from "@/lib/format";
import { describeMaintenanceError } from "@/lib/system/maintenance";
import { sidecarStatus } from "@/lib/system/status";
import { MaintenanceProgress } from "./maintenance-progress";
import { StatCard } from "./stat-card";
import { StatusBadge } from "./status-badge";
import { SystemErrorState } from "./system-error-state";
import { SystemPage } from "./system-page";

const ALL_ROOTS = "__all__";

/** Admin controls for preview cache maintenance, independent of text indexing. */
export function ThumbnailsPage() {
  const { data, isLoading, error, dataUpdatedAt, refetch } = useSystemThumbnails();
  const indexer = useSystemIndexer();
  const rebuild = useRebuildIndexerThumbnails();
  const clear = useClearThumbnails();
  const busy =
    useSystemMaintenanceBusy(indexer.data?.stats) || rebuild.isPending || clear.isPending;
  const unavailable = !data?.configured || !indexer.data?.reachable || !!error || !!indexer.error;
  // The thumbnail cache is produced by the indexer, so its own badge and
  // description share one status computed from both FDRIVE_THUMBS_DIR
  // (`data.configured`) and the indexer's configured/reachable state,
  // rather than describing "available" from one signal while the badge
  // below shows "Not configured" from another.
  const thumbnailsConfigured = (data?.configured ?? false) && (indexer.data?.configured ?? false);
  const status = sidecarStatus(thumbnailsConfigured, indexer.data?.reachable ?? false);
  const rootNames =
    indexer.data?.health?.roots ?? indexer.data?.stats?.roots.map((root) => root.root) ?? [];
  const [rebuildOpen, setRebuildOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [root, setRoot] = useState(ALL_ROOTS);
  const [path, setPath] = useState("");
  const [force, setForce] = useState(false);

  function handleRebuildConfirm() {
    rebuild.mutate(
      {
        ...(root !== ALL_ROOTS ? { root } : {}),
        ...(path.trim() ? { path: path.trim() } : {}),
        ...(force ? { force: true } : {}),
      },
      {
        onSuccess: (result) => {
          toast.success(
            result.total > 0
              ? `Rebuilding ${result.total} thumbnail${result.total === 1 ? "" : "s"}…`
              : "No thumbnails need rebuilding.",
          );
          setRebuildOpen(false);
          setRoot(ALL_ROOTS);
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
      description="The indexer's on-disk thumbnail cache."
      lastUpdated={dataUpdatedAt > 0 ? new Date(dataUpdatedAt) : null}
      actions={
        <>
          <Button
            type="button"
            variant="outline"
            disabled={unavailable || busy}
            onClick={() => setClearOpen(true)}
          >
            Clear cache
          </Button>
          <Button type="button" disabled={unavailable || busy} onClick={() => setRebuildOpen(true)}>
            Rebuild
          </Button>
        </>
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
                {status === "ok"
                  ? "Thumbnail cache is available."
                  : status === "unreachable"
                    ? "The indexer that generates thumbnails is unreachable."
                    : "Not configured: set FDRIVE_THUMBS_DIR and FDRIVE_INDEXER_URL."}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <StatusBadge status={status} />
              <p className="text-sm text-muted-foreground">
                Rebuild fills missing previews for photos, PDFs, and videos. Force rebuild replaces
                existing previews. Clear cache removes previews globally. Original files, text,
                search data, and metadata stay unchanged. Normal indexing or on-demand generation
                can create previews again.
              </p>
            </CardContent>
          </Card>
          {indexer.error ? (
            <SystemErrorState error={indexer.error} onRetry={() => void indexer.refetch()} />
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <StatCard label="Thumbnails" value={data.count.toLocaleString()} />
            <StatCard label="Cache size" value={formatBytes(data.bytes)} />
          </div>
          <MaintenanceProgress
            title="Thumbnail rebuild"
            job={indexer.data?.stats?.thumbnailRebuild}
          />
          <MaintenanceProgress
            title="Thumbnail cache clear"
            job={indexer.data?.stats?.thumbnailClear}
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
              <FieldLabel htmlFor="rebuild-root">Root</FieldLabel>
              <Select
                value={root}
                onValueChange={(value) => {
                  setRoot(value ?? ALL_ROOTS);
                  setPath("");
                }}
              >
                <SelectTrigger id="rebuild-root">
                  <SelectValue>{root === ALL_ROOTS ? "All roots" : root}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_ROOTS}>All roots</SelectItem>
                  {rootNames.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                Choose every root or limit the rebuild to one root.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="rebuild-path">Path (optional)</FieldLabel>
              <Input
                id="rebuild-path"
                value={path}
                disabled={root === ALL_ROOTS}
                onChange={(event) => setPath(event.target.value)}
                placeholder="Whole root"
              />
              <FieldDescription>
                Choose a root first, then enter a file or folder path relative to it.
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
              Removes cached previews for all roots, including unused preview files. Original files,
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
              Clear cache
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SystemPage>
  );
}
