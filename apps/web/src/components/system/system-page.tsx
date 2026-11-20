"use client";

import type {
  FeatureId,
  FeatureStatus,
  ProcessingFeature,
  SystemFeaturesResponse,
} from "@fdrive/contracts";
import type { ReactNode } from "react";
import { DetailSheet } from "@/components/shell/list-sheet";
import { StatusBadge, type StatusTone } from "@/components/shell/status";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { describeApiError } from "@/lib/api/errors";
import { useSystemFeatures, useUpdateFeatures } from "@/lib/api/system-queries";
import { changeFeature, FEATURE_DESCRIPTIONS } from "@/lib/system/features";
import { formatRelativeTime } from "@/lib/system/format";
import { FAILURE_FEATURES, ProcessingFailures } from "./processing-failures";
import { SystemAlert } from "./system-section";

export interface SystemPageProps {
  /** The area's name: the sheet's title and the page's heading. */
  title: string;
  /** One line under the title saying what the area does. */
  description: string;
  /** When the data behind this page was last fetched. `null` while loading. */
  lastUpdated: Date | null;
  /** `StatusBadge`s for the area's own state, after the On or Off badge: Reachable, a model. */
  badges?: ReactNode;
  /** The sheet's buttons, the one primary button last. Hidden while the area is off. */
  actions?: ReactNode;
  /**
   * The sheet's last row: a note on the left and the destructive text button at the far end.
   * Hidden while the area is off.
   */
  footer?: ReactNode;
  /**
   * The optional feature (or features) this area administers. The first one is the area's own:
   * the sheet's header carries its switch and its On or Off badge. The content shows while any
   * of them is on; with all of them off it is replaced by what turning the feature on does.
   */
  feature?: FeatureId | readonly FeatureId[];
  /**
   * For an area whose activation is not a `FeatureId`, such as Office: `false` shows the off
   * state in place of the content, and the area brings its own `toggle`.
   */
  enabled?: boolean;
  /** The on/off control of an area that is not a `FeatureId`, shown where a feature's switch is. */
  toggle?: ReactNode;
  /** What an area that is not a `FeatureId` says while it is off. */
  offNote?: ReactNode;
  children: ReactNode;
}

const STATE_BADGES: Record<FeatureStatus["state"], { tone: StatusTone; label: string }> = {
  off: { tone: "off", label: "Off" },
  preparing: { tone: "warning", label: "Preparing" },
  ready: { tone: "success", label: "On" },
  blocked: { tone: "warning", label: "Needs attention" },
  failed: { tone: "danger", label: "Failed" },
  stopping: { tone: "warning", label: "Stopping" },
};

/** What turning the feature on costs, and what it switches on or off with it. */
function featureNote(id: FeatureId): string {
  const info = FEATURE_DESCRIPTIONS[id];
  return [info.cost, info.dependency].filter(Boolean).join(" ");
}

/**
 * The sheet every System area is drawn in: the title with its one-line description and status
 * badges, the area's actions, then its content. An area that is an optional feature gets its
 * switch in the header, which saves at once, and while it is off the sheet says what turning it
 * on does in place of the content. The pages poll every 5 seconds (`refetchInterval` in
 * `lib/api/system-queries`), and the badge row ends in when that last happened.
 */
export function SystemPage({
  title,
  description,
  lastUpdated,
  badges,
  actions,
  footer,
  feature,
  enabled,
  toggle,
  offNote,
  children,
}: SystemPageProps) {
  const features = useSystemFeatures();
  const update = useUpdateFeatures();
  const ids = feature === undefined ? [] : typeof feature === "string" ? [feature] : feature;
  const own = ids[0];
  const data = features.data;
  const featureOff =
    ids.length > 0 && data !== undefined && ids.every((id) => !data.configuration.values[id]);
  const disabled = featureOff || enabled === false;
  const failureFeature = ids.find((id) => FAILURE_FEATURES.includes(id as ProcessingFeature)) as
    | ProcessingFeature
    | undefined;
  const status = own === undefined ? undefined : data?.statuses.find((entry) => entry.id === own);

  function save(values: SystemFeaturesResponse["configuration"]["values"]) {
    if (data === undefined) return;
    update.mutate({
      revision: data.configuration.revision,
      values,
      walkthroughComplete: data.configuration.walkthroughComplete,
      walkthroughStep: data.configuration.walkthroughStep ?? 0,
    });
  }

  const stateBadge =
    own !== undefined && data !== undefined ? (
      <FeatureBadge on={data.configuration.values[own]} status={status} />
    ) : enabled === undefined ? null : (
      <StatusBadge tone={enabled ? "success" : "off"}>{enabled ? "On" : "Off"}</StatusBadge>
    );

  return (
    <DetailSheet
      title={title}
      lede={description}
      badges={
        <>
          {stateBadge}
          {disabled ? null : badges}
          {lastUpdated !== null ? (
            <span className="whitespace-nowrap text-muted-foreground text-xs">
              Updated {formatRelativeTime(lastUpdated, new Date())}
            </span>
          ) : null}
        </>
      }
      actions={
        <>
          {disabled || !actions ? null : (
            <div data-slot="system-page-actions" className="contents">
              {actions}
            </div>
          )}
          {own !== undefined && data !== undefined ? (
            <Switch
              aria-label={`Enable ${FEATURE_DESCRIPTIONS[own].title.toLowerCase()}`}
              title={featureNote(own)}
              checked={data.configuration.values[own]}
              disabled={update.isPending}
              onCheckedChange={(checked) =>
                save(changeFeature(data.configuration.values, own, checked))
              }
            />
          ) : (
            toggle
          )}
        </>
      }
      footer={disabled ? undefined : footer}
    >
      {update.isError ? <SystemAlert>{describeApiError(update.error)}</SystemAlert> : null}
      {status?.state === "failed" || status?.state === "blocked" ? (
        <div
          data-slot="feature-problem"
          className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3"
        >
          <SystemAlert className="min-w-0 flex-[1_1_16rem]">{status.detail}</SystemAlert>
          {status.state === "failed" && data !== undefined ? (
            <Button
              variant="outline"
              disabled={update.isPending}
              onClick={() => save(data.configuration.values)}
            >
              Retry preparation
            </Button>
          ) : null}
        </div>
      ) : null}
      {failureFeature ? (
        <ProcessingFailures feature={failureFeature} retryEnabled={!disabled} />
      ) : null}
      {disabled ? (
        <div data-slot="system-page-off" className="flex max-w-prose flex-col gap-2 text-sm">
          <p className="font-medium">{title} is off</p>
          {own !== undefined ? (
            <>
              <p className="text-muted-foreground">
                {FEATURE_DESCRIPTIONS[own].description} {featureNote(own)}
              </p>
              <p className="text-muted-foreground">
                Processing is inactive. Existing index and cache data are retained.
              </p>
            </>
          ) : offNote !== undefined && offNote !== null ? (
            <div className="text-muted-foreground">{offNote}</div>
          ) : null}
        </div>
      ) : (
        children
      )}
    </DetailSheet>
  );
}

/** The area's own state as a badge: the worker's reported state while on, Off otherwise. */
function FeatureBadge({ on, status }: { on: boolean; status: FeatureStatus | undefined }) {
  const badge =
    status === undefined ? STATE_BADGES[on ? "ready" : "off"] : STATE_BADGES[status.state];
  return (
    <StatusBadge tone={badge.tone} title={status?.detail}>
      {badge.label}
    </StatusBadge>
  );
}
