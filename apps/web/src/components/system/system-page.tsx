"use client";

import type { FeatureId } from "@fdrive/contracts";
import Link from "next/link";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { useSystemFeatures } from "@/lib/api/system-queries";
import { formatRelativeTime } from "@/lib/system/format";

export interface SystemPageProps {
  /** Shown in the breadcrumb ("System / {title}") and as the page heading. */
  title: string;
  description: string;
  /** When the data behind this page was last fetched. `null` while loading. */
  lastUpdated: Date | null;
  /** Right-aligned page-specific controls (Reindex, Run now, Rebuild, ...). */
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * Shared layout for every System sidecar page: the shell's page header, a
 * title and description, a "Last updated" caption (the pages themselves
 * poll every 5 seconds via `refetchInterval` in `lib/api/system-queries`),
 * and a content area.
 */
export function SystemPage({
  title,
  description,
  lastUpdated,
  actions,
  children,
}: SystemPageProps) {
  const features = useSystemFeatures();
  const pageFeatures: Record<string, FeatureId[]> = {
    Indexer: ["thumbnails", "textSearch", "imageSearch"],
    OCR: ["pdfOcr"],
    Search: ["semanticSearch"],
    "Image search": ["imageSearch"],
    Thumbnails: ["thumbnails"],
  };
  const ids = pageFeatures[title];
  const disabled =
    ids !== undefined &&
    features.data !== undefined &&
    features.data.source !== "legacy" &&
    ids.every((id) => !features.data.configuration.values[id]);
  return (
    <>
      <PageHeader breadcrumbs={<span className="text-sm font-medium">System / {title}</span>} />
      <div className="flex flex-1 flex-col gap-6 p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
          <div className="flex items-center gap-3">
            {lastUpdated !== null ? (
              <span className="text-xs text-muted-foreground">
                Last updated {formatRelativeTime(lastUpdated, new Date())}
              </span>
            ) : null}
            {disabled ? null : actions}
          </div>
        </div>
        {disabled ? (
          <div className="rounded-lg border p-5 text-sm space-y-2">
            <p className="font-medium">{title} is off</p>
            <p className="text-muted-foreground">
              Processing is inactive. Existing index and cache data are retained.
            </p>
            <Link href="/system/features" className="underline">
              Manage features
            </Link>
          </div>
        ) : (
          children
        )}
      </div>
    </>
  );
}
