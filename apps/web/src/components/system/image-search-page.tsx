"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
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
import { Switch } from "@/components/ui/switch";
import {
  useClearImageSearch,
  useRebuildImageSearch,
  useSystemImageSearch,
  useSystemMaintenanceBusy,
} from "@/lib/api/system-queries";
import { describeMaintenanceError } from "@/lib/system/maintenance";
import { sidecarStatus } from "@/lib/system/status";
import { MaintenanceProgress } from "./maintenance-progress";
import { StatGrid } from "./stat-grid";
import { StatusBadge } from "./status-badge";
import { SystemErrorState } from "./system-error-state";
import { SystemPage } from "./system-page";
import { SystemSection } from "./system-section";

/** Admin controls for image-content (thumbnail embedding) search maintenance. */
export function ImageSearchPage() {
  const { data, isLoading, error, dataUpdatedAt, refetch } = useSystemImageSearch();
  const rebuild = useRebuildImageSearch();
  const clear = useClearImageSearch();
  const busy = useSystemMaintenanceBusy(undefined) || rebuild.isPending || clear.isPending;
  const unavailable = !data?.configured || !data?.healthy || !!error;
  const status = sidecarStatus(data?.configured ?? false, data?.healthy ?? false);
  const [rebuildOpen, setRebuildOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [force, setForce] = useState(false);

  const modelMismatch =
    data !== undefined &&
    data.embeddedModel !== null &&
    data.model !== undefined &&
    data.embeddedModel !== data.model;

  function handleRebuildConfirm() {
    rebuild.mutate(
      { ...(force ? { force: true } : {}) },
      {
        onSuccess: (result) => {
          toast.success(
            result.total > 0
              ? `Rebuilding ${result.total} image embedding${result.total === 1 ? "" : "s"}…`
              : "No image embeddings need rebuilding.",
          );
          setRebuildOpen(false);
          setForce(false);
        },
        onError: (err) => toast.error(describeMaintenanceError(err)),
      },
    );
  }

  function handleClearConfirm() {
    clear.mutate(undefined, {
      onSuccess: () => {
        toast.success("Image embedding clear started.");
        setClearOpen(false);
      },
      onError: (err) => toast.error(describeMaintenanceError(err)),
    });
  }

  return (
    <SystemPage
      title="Image search"
      description="Search images by what they show, not just their name."
      lastUpdated={dataUpdatedAt > 0 ? new Date(dataUpdatedAt) : null}
      feature="imageSearch"
      actions={
        <>
          <Button
            type="button"
            variant="outline"
            disabled={unavailable || busy}
            onClick={() => setClearOpen(true)}
          >
            Clear embeddings
          </Button>
          <Button type="button" disabled={unavailable || busy} onClick={() => setRebuildOpen(true)}>
            Rebuild
          </Button>
          {/* LogSheet mounts here (P9 event log) */}
        </>
      }
    >
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : error ? (
        <SystemErrorState error={error} onRetry={() => void refetch()} />
      ) : data === undefined ? null : (
        <>
          <SystemSection
            title="Status"
            description={
              status === "ok"
                ? `Reachable. Model ${data.model ?? "unknown"}, dimension ${data.dim ?? "unknown"}.`
                : status === "unreachable"
                  ? "The image-embedding sidecar is unreachable."
                  : "Not configured: set FDRIVE_IMAGE_EMBED_URL."
            }
          >
            <StatusBadge status={status} />
            <p className="text-sm text-muted-foreground">
              Image search matches a thumbnail's contents to a text query using a SigLIP 2 embedding
              sidecar. Rebuild fills missing embeddings for photos with a thumbnail. Force rebuild
              replaces embeddings written by a different model. Clear removes every embedding.
              Original files, thumbnails, and text search data stay unchanged.
            </p>
          </SystemSection>
          <StatGrid
            stats={[
              { label: "Embedded thumbnails", value: data.embedded.toLocaleString() },
              {
                label: "Embedding model",
                value: (
                  <span className="flex items-center gap-2">
                    {data.embeddedModel ?? "None yet"}
                    {modelMismatch ? <Badge variant="destructive">Model mismatch</Badge> : null}
                  </span>
                ),
                ...(modelMismatch
                  ? {
                      hint: `The sidecar now runs ${data.model}. Force rebuild to replace these rows.`,
                    }
                  : {}),
              },
            ]}
          />
          <MaintenanceProgress title="Image embedding rebuild" job={data.rebuild} />
          <MaintenanceProgress title="Image embedding clear" job={data.clear} />
        </>
      )}
      <Dialog open={rebuildOpen} onOpenChange={setRebuildOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rebuild image embeddings</DialogTitle>
            <DialogDescription>
              Generates embeddings for thumbnails that do not have one yet. Text and search data are
              not touched.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <Field orientation="horizontal">
              <FieldLabel htmlFor="image-search-force">Replace rows from other models</FieldLabel>
              <Switch id="image-search-force" checked={force} onCheckedChange={setForce} />
            </Field>
            <FieldDescription>
              Off fills missing embeddings only; on also re-embeds rows written by a different
              model.
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
            <DialogTitle>Clear image embeddings?</DialogTitle>
            <DialogDescription>
              Removes every stored image embedding. Original files, thumbnails, extracted text,
              tags, favorites, and recents stay. Rebuild can recreate embeddings afterward.
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
              Clear embeddings
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SystemPage>
  );
}
