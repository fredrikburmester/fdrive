"use client";

import { useState } from "react";
import { toast } from "sonner";
import { SheetColumns } from "@/components/shell/list-sheet";
import { BarList, Code, type Fact, FactList } from "@/components/shell/sheet-data";
import { StatusBadge } from "@/components/shell/status";
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
import { describeApiError } from "@/lib/api/errors";
import { useReembed, useSystemSearch } from "@/lib/api/system-queries";
import { sidecarStatus } from "@/lib/system/status";
import { LogSheet } from "./log-sheet";
import { StatGrid } from "./stat-grid";
import { StatusBadge as SidecarBadge } from "./status-badge";
import { SystemErrorState } from "./system-error-state";
import { SystemPage } from "./system-page";
import { SystemLine, SystemSection } from "./system-section";

/** The size of every stored embedding: the index's vector column is this wide. */
const EMBEDDING_DIMENSIONS = 384;

/**
 * Admin page: `System > Semantic search`. The embedding model's state, how much of the index is
 * embedded, and a re-embed action.
 */
export function SearchPage() {
  const { data, isLoading, error, dataUpdatedAt, refetch } = useSystemSearch();
  const reembed = useReembed();
  const [reembedOpen, setReembedOpen] = useState(false);

  const status =
    data !== undefined ? sidecarStatus(data.semantic.configured, data.semantic.healthy) : null;

  function handleReembedConfirm() {
    reembed.mutate(undefined, {
      onSuccess: (result) => {
        toast.success(
          `Marked ${result.marked} file${result.marked === 1 ? "" : "s"} for re-embedding.`,
        );
        setReembedOpen(false);
      },
      onError: (err) => toast.error(describeApiError(err)),
    });
  }

  const modelFacts: Fact[] = [];
  if (data?.semantic.model !== undefined) {
    modelFacts.push({ label: "Model", value: data.semantic.model });
  }
  modelFacts.push({ label: "Dimensions", value: EMBEDDING_DIMENSIONS.toLocaleString() });
  if (data?.semantic.maxInputLength !== undefined) {
    modelFacts.push({
      label: "Max input",
      value: `${data.semantic.maxInputLength.toLocaleString()} tokens`,
    });
  }

  return (
    <SystemPage
      title="Semantic search"
      description="Semantic embeddings and the hybrid search index."
      lastUpdated={dataUpdatedAt > 0 ? new Date(dataUpdatedAt) : null}
      feature="semanticSearch"
      badges={
        status === null || error !== null ? null : (
          <>
            <SidecarBadge status={status} />
            {data?.semantic.model !== undefined ? (
              <StatusBadge>{data.semantic.model}</StatusBadge>
            ) : null}
          </>
        )
      }
      actions={
        <>
          <LogSheet subsystem="search" />
          <Button
            type="button"
            size="lg"
            onClick={() => setReembedOpen(true)}
            disabled={data === undefined || !data.configured}
          >
            Re-embed
          </Button>
        </>
      }
      footer={
        <p className="min-w-0 flex-[1_1_16rem] text-muted-foreground">
          Re-embed re-extracts and re-embeds every file from scratch. On a large index this can take
          a long time.
        </p>
      }
    >
      {isLoading ? (
        <SystemLine role="status">Loading…</SystemLine>
      ) : error ? (
        <SystemErrorState error={error} onRetry={() => void refetch()} />
      ) : data === undefined ? null : (
        <>
          <StatGrid
            stats={[
              { label: "Files", value: data.index.files.toLocaleString() },
              { label: "With text", value: data.index.withText.toLocaleString() },
              { label: "Chunks", value: data.index.chunks.toLocaleString() },
              { label: "Embedded", value: data.index.embedded.toLocaleString() },
            ]}
          />
          <SheetColumns>
            <SystemSection title="Chunks">
              <BarList
                total={data.index.chunks}
                items={[
                  { label: "Embedded", value: data.index.embedded, tone: "success" },
                  {
                    label: "Pending",
                    value: Math.max(data.index.chunks - data.index.embedded, 0),
                  },
                ]}
              />
            </SystemSection>
            <SystemSection
              title="Embedding model"
              description={
                status === "not_configured" ? (
                  <>
                    Not configured: set <Code>FDRIVE_ML_URL</Code>.
                  </>
                ) : status === "unreachable" ? (
                  "The embedding model is unreachable. Its name and limit show here when it answers again."
                ) : (
                  "Each chunk of text becomes a vector, so search can rank results by meaning, not just matching words."
                )
              }
            >
              <FactList facts={modelFacts} />
            </SystemSection>
          </SheetColumns>
        </>
      )}

      <AlertDialog open={reembedOpen} onOpenChange={setReembedOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Re-embed everything?</AlertDialogTitle>
            <AlertDialogDescription>
              Today this re-extracts and re-embeds every file from scratch, not just the embeddings.
              On a large index this can take a long time and reload the indexer with work.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="max-md:min-h-11">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="max-md:min-h-11"
              disabled={reembed.isPending}
              onClick={handleReembedConfirm}
            >
              Re-embed
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SystemPage>
  );
}
