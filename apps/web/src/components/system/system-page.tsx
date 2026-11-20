"use client";

import type { FeatureId, ProcessingFeature } from "@fdrive/contracts";
import { cn } from "cn";
import { PowerOff } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { PageBar, PageBody, PageEmpty } from "@/components/shell/page-layout";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { useSystemFeatures } from "@/lib/api/system-queries";
import { formatRelativeTime } from "@/lib/system/format";
import { SYSTEM_SCOPE_NOTE } from "@/lib/system/pages";
import { FAILURE_FEATURES, ProcessingFailures } from "./processing-failures";

export interface SystemPageProps {
  /** The page's heading, shown as the last step of the header's "System > {title}" trail. */
  title: string;
  description: string;
  /** When the data behind this page was last fetched. `null` while loading. */
  lastUpdated: Date | null;
  /** Page-specific controls; they move below the heading on narrow screens. */
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

/** The phone header's title weight, as the file browser's folder name has there. */
const PHONE_TITLE = "max-md:px-1.5 max-md:font-semibold max-md:text-[15px]";

/**
 * The header's trail, "System > Page", like a folder's breadcrumb and the one
 * on Settings. System has no page of its own, so its name is not a link. A
 * phone keeps only the page's name, which is the page's heading.
 */
function SystemTrail({ title }: { title: string }) {
  return (
    <Breadcrumb className="min-w-0 flex-1">
      <BreadcrumbList className="min-w-0 flex-nowrap">
        <BreadcrumbItem className="px-1 max-md:hidden">System</BreadcrumbItem>
        <BreadcrumbSeparator className="max-md:hidden" />
        <BreadcrumbItem className="min-w-0">
          <h1
            aria-current="page"
            className={cn("truncate rounded-sm px-1 font-normal text-foreground", PHONE_TITLE)}
          >
            {title}
          </h1>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}

/**
 * Shared layout for every System sidecar page: the shell's page header with
 * the "System > Page" trail, whose last step is the page's heading, then a
 * bar with the page's description, the installation-wide scope note, a "Last
 * updated" caption (the pages themselves poll every 5 seconds via
 * `refetchInterval` in `lib/api/system-queries`) and the page's actions, then
 * the content, edge to edge like the file list.
 */
export function SystemPage({
  title,
  description,
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
      <PageHeader breadcrumbs={<SystemTrail title={title} />} />
      <PageBody>
        <PageBar>
          <div className="flex min-w-0 flex-1 basis-72 flex-wrap items-center gap-x-3 gap-y-0.5">
            <p>{description}</p>
            <p className="text-muted-foreground/80">{SYSTEM_SCOPE_NOTE}</p>
            {lastUpdated !== null ? (
              <span className="shrink-0 whitespace-nowrap text-muted-foreground/80">
                Last updated {formatRelativeTime(lastUpdated, new Date())}
              </span>
            ) : null}
          </div>
          {disabled || !actions ? null : (
            <div
              data-slot="system-page-actions"
              className="flex max-w-full flex-wrap items-center gap-1.5 max-md:basis-full [&>button]:min-h-11 md:[&>button]:min-h-0"
            >
              {actions}
            </div>
          )}
        </PageBar>
        {failureFeature ? (
          <ProcessingFailures feature={failureFeature} retryEnabled={!disabled} />
        ) : null}
        {disabled ? (
          <PageEmpty
            icon={PowerOff}
            title={`${title} is off`}
            description="Processing is inactive. Existing index and cache data are retained."
            action={
              <Link href="/system/features" className="text-sm underline underline-offset-4">
                Manage features
              </Link>
            }
          />
        ) : (
          children
        )}
      </PageBody>
    </>
  );
}
