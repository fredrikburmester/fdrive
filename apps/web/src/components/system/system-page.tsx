"use client";

import type { FeatureId, ProcessingFeature } from "@fdrive/contracts";
import Link from "next/link";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { useSystemFeatures } from "@/lib/api/system-queries";
import { formatRelativeTime } from "@/lib/system/format";
import { SYSTEM_SCOPE_NOTES, type SystemScope } from "@/lib/system/pages";
import { FAILURE_FEATURES, ProcessingFailures } from "./processing-failures";

export interface SystemPageProps {
  /** Shown in the breadcrumb ("System / {title}") and as the page heading. */
  title: string;
  description: string;
  /** What the settings apply to; `server` unless the page edits per-server settings. */
  scope?: SystemScope;
  /** When the data behind this page was last fetched. `null` while loading. */
  lastUpdated: Date | null;
  /** Page-specific controls; wrap below the heading on narrow screens. */
  actions?: ReactNode;
  /**
   * The feature (or features) whose processing this page administers. The
   * page is shown while any of them is on; with all of them off it is
   * replaced by a pointer to the feature controls.
   */
  feature?: FeatureId | readonly FeatureId[];
  /**
   * An extra gate for a page whose activation is not a `FeatureId`, such as
   * Office. `false` shows the same off panel as a disabled `feature`.
   */
  enabled?: boolean;
  children: ReactNode;
}

/**
 * Shared layout for every System sidecar page: the shell's page header, a
 * title and description, a scope note, a "Last updated" caption (the pages themselves
 * poll every 5 seconds via `refetchInterval` in `lib/api/system-queries`),
 * and a content area.
 */
export function SystemPage({
  title,
  description,
  scope = "server",
  lastUpdated,
  actions,
  feature,
  enabled,
  children,
}: SystemPageProps) {
  const features = useSystemFeatures();
  const ids = feature === undefined ? [] : typeof feature === "string" ? [feature] : feature;
  const featureOff =
    ids.length > 0 &&
    features.data !== undefined &&
    ids.every((id) => !features.data.configuration.values[id]);
  const disabled = featureOff || enabled === false;
  const failureFeature = ids.find((id) => FAILURE_FEATURES.includes(id as ProcessingFeature)) as
    | ProcessingFeature
    | undefined;
  return (
    <>
      <PageHeader breadcrumbs={<span className="text-sm font-medium">System / {title}</span>} />
      <div className="flex min-w-0 flex-1 flex-col gap-6 p-4 sm:p-6">
        <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
            <p className="text-sm text-muted-foreground">{description}</p>
            <p className="mt-1 text-xs text-muted-foreground/80">{SYSTEM_SCOPE_NOTES[scope]}</p>
          </div>
          <div className="flex min-w-0 max-w-full flex-col items-start gap-3 sm:flex-row sm:flex-wrap sm:items-center">
            {lastUpdated !== null ? (
              <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                Last updated {formatRelativeTime(lastUpdated, new Date())}
              </span>
            ) : null}
            {disabled || !actions ? null : (
              <div className="flex max-w-full flex-wrap items-center gap-2 [&>button]:min-h-11 sm:[&>button]:min-h-0">
                {actions}
              </div>
            )}
          </div>
        </div>
        {failureFeature ? (
          <ProcessingFailures feature={failureFeature} retryEnabled={!disabled} />
        ) : null}
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
