"use client";

import { useState } from "react";
import { toast } from "sonner";
import { SettingRow } from "@/components/shell/page-layout";
import { Code, type Fact, FactList } from "@/components/shell/sheet-data";
import { StatusBadge } from "@/components/shell/status";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import {
  useClearImageSearch,
  useRebuildImageSearch,
  useSystemImageSearch,
  useSystemMaintenanceBusy,
} from "@/lib/api/system-queries";
import { describeMaintenanceError } from "@/lib/system/maintenance";
import { sidecarStatus } from "@/lib/system/status";
import { LogSheet } from "./log-sheet";
import { MaintenanceProgress } from "./maintenance-progress";
import { StatGrid } from "./stat-grid";
import { StatusBadge as SidecarBadge } from "./status-badge";
import { SystemErrorState } from "./system-error-state";
import { SystemPage } from "./system-page";
import { SystemLine, SystemSection } from "./system-section";

/** Admin controls for image-content (thumbnail embedding) search maintenance. */
export function ImageSearchPage() {
  const { data, isLoading, error, dataUpdatedAt, refetch } = useSystemImageSearch();
  const rebuild = useRebuildImageSearch();
  const clear = useClearImageSearch();
  const busy =
    useSystemMaintenanceBusy(undefined) ||
    rebuild.isPending ||
    clear.isPending ||
    data?.rebuild?.running === true ||
    data?.clear?.running === true;
  const unavailable = !data?.configured || !data?.healthy || !!error;
  const status =
    data?.status === "loading"
      ? "loading"
      : sidecarStatus(data?.configured ?? false, data?.healthy ?? false);
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
            result.total === null
              ? "Rebuild started. Discovering files…"
              : result.total > 0
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

  const modelFacts: Fact[] = [];
  if (data?.model !== undefined) modelFacts.push({ label: "Model", value: data.model });
  if (data?.dim !== undefined) {
    modelFacts.push({ label: "Dimensions", value: data.dim.toLocaleString() });
  }
  modelFacts.push({ label: "Embedded with", value: data?.embeddedModel ?? "None yet" });

  return (
    <SystemPage
      title="Image search"
      description="Search images by what they show, not just their name."
      lastUpdated={dataUpdatedAt > 0 ? new Date(dataUpdatedAt) : null}
      feature="imageSearch"
      badges={
        data === undefined || error !== null ? null : (
          <>
            <SidecarBadge status={status} />
            {data.model !== undefined ? <StatusBadge>{data.model}</StatusBadge> : null}
            {modelMismatch ? <StatusBadge tone="warning">Model mismatch</StatusBadge> : null}
          </>
        )
      }
      actions={
        <>
          <LogSheet subsystem="image-search" />
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
            Clearing removes every image embedding. Your files, thumbnails and text search are not
            touched.
          </p>
          <Button
            type="button"
            variant="destructive"
            size="lg"
            className="ml-auto sheet:px-2"
            disabled={unavailable || busy}
            onClick={() => setClearOpen(true)}
          >
            Clear embeddings
          </Button>
        </>
      }
    >
      {isLoading ? (
        <SystemLine role="status">Loading…</SystemLine>
      ) : error ? (
        <SystemErrorState error={error} onRetry={() => void refetch()} />
      ) : data === undefined ? null : (
        <>
          <MaintenanceProgress title="Image embedding rebuild" job={data.rebuild} />
          <MaintenanceProgress title="Image embedding clear" job={data.clear} />
          <StatGrid
            stats={[{ label: "Embedded thumbnails", value: data.embedded.toLocaleString() }]}
          />
          <SystemSection
            title="Embeddings"
            description={
              status === "loading" ? (
                "The image search model is loading."
              ) : status === "unreachable" ? (
                "The image search model is unreachable."
              ) : status === "not_configured" ? (
                <>
                  Not configured: set <Code>FDRIVE_ML_URL</Code>.
                </>
              ) : (
                "Each thumbnail becomes a vector, so a search in words can match what a picture shows."
              )
            }
            padded
          >
            <FactList facts={modelFacts} />
            {modelMismatch ? (
              <p className="max-w-prose text-warning">
                The model is now {data.model}. Rebuild with Replace rows from other models turned on
                to re-embed these thumbnails.
              </p>
            ) : null}
          </SystemSection>
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
          <SettingRow
            label="Replace rows from other models"
            description="Off fills missing embeddings only. On also re-embeds rows written by a different model."
            htmlFor="image-search-force"
            align="end"
          >
            <Switch id="image-search-force" checked={force} onCheckedChange={setForce} />
          </SettingRow>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="max-md:min-h-11"
              onClick={() => setRebuildOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="max-md:min-h-11"
              disabled={unavailable || busy}
              onClick={handleRebuildConfirm}
            >
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
            <Button
              type="button"
              variant="outline"
              className="max-md:min-h-11"
              onClick={() => setClearOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="max-md:min-h-11"
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
