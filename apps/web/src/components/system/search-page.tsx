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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { describeApiError } from "@/lib/api/errors";
import { useReembed, useSystemSearch } from "@/lib/api/system-queries";
import { sidecarStatus } from "@/lib/system/status";
import { StatCard } from "./stat-card";
import { StatusBadge } from "./status-badge";
import { SystemErrorState } from "./system-error-state";
import { SystemPage } from "./system-page";

/** Admin page: `System > Search`. Semantic status, index totals, and a re-embed action. */
export function SearchPage() {
  const { data, isLoading, error, dataUpdatedAt, refetch } = useSystemSearch();
  const reembed = useReembed();
  const [reembedOpen, setReembedOpen] = useState(false);

  function handleReembedConfirm() {
    reembed.mutate(undefined, {
      onSuccess: (result) => {
        toast.success(
          `Marked ${result.marked} file${result.marked === 1 ? "" : "s"} across ${result.roots.length} root${result.roots.length === 1 ? "" : "s"}.`,
        );
        setReembedOpen(false);
      },
      onError: (err) => toast.error(describeApiError(err)),
    });
  }

  return (
    <SystemPage
      title="Search"
      description="Semantic embeddings and the hybrid search index."
      lastUpdated={dataUpdatedAt > 0 ? new Date(dataUpdatedAt) : null}
      actions={
        <Button
          type="button"
          variant="outline"
          onClick={() => setReembedOpen(true)}
          disabled={data === undefined || !data.configured}
        >
          Re-embed
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
              <CardTitle>Semantic search</CardTitle>
              <CardDescription>
                The embedding server (TEI) fdrive queries at search time.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <StatusBadge
                  status={sidecarStatus(data.semantic.configured, data.semantic.healthy)}
                />
                {data.semantic.model !== undefined ? (
                  <Badge variant="secondary">{data.semantic.model}</Badge>
                ) : null}
                {data.semantic.maxInputLength !== undefined ? (
                  <Badge variant="outline">max input {data.semantic.maxInputLength} tokens</Badge>
                ) : null}
              </div>
              <p className="text-sm text-muted-foreground">
                Each chunk of text is turned into a 384-dimension vector by this model, so search
                can rank results by meaning, not just matching words. The badge above shows the
                model's own limit on how much text it can embed at once.
              </p>
              <p className="text-sm text-muted-foreground">
                Re-embed re-extracts and re-embeds every file in every configured root from scratch,
                not just the embeddings. On a large index this can take a long time and loads the
                indexer with work.
              </p>
            </CardContent>
          </Card>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label="Files" value={data.index.files.toLocaleString()} />
            <StatCard label="With text" value={data.index.withText.toLocaleString()} />
            <StatCard label="Chunks" value={data.index.chunks.toLocaleString()} />
            <StatCard label="Embedded" value={data.index.embedded.toLocaleString()} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Roots</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {data.roots.length === 0 ? (
                <p className="text-sm text-muted-foreground">No index roots are configured.</p>
              ) : (
                data.roots.map((root) => (
                  <Badge key={root} variant="secondary">
                    {root}
                  </Badge>
                ))
              )}
            </CardContent>
          </Card>
        </>
      )}

      <AlertDialog open={reembedOpen} onOpenChange={setReembedOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Re-embed everything?</AlertDialogTitle>
            <AlertDialogDescription>
              Today this re-extracts and re-embeds every file in every configured root from scratch,
              not just the embeddings. On a large index this can take a long time and reload the
              indexer with work.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={reembed.isPending} onClick={handleReembedConfirm}>
              Re-embed
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SystemPage>
  );
}
