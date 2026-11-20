"use client";

import type { SystemActivityItem } from "@fdrive/contracts";
import { CircleAlert, LoaderCircle } from "lucide-react";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { AreaList, ListSheet, ListSheetTrail } from "@/components/shell/list-sheet";
import { PageHeader } from "@/components/shell/page-header";
import { StatusDot } from "@/components/shell/status";
import { useSystemAi } from "@/lib/ai/queries";
import { useSystemActivity } from "@/lib/api/activity-queries";
import { useSystemOffice } from "@/lib/api/office-settings-queries";
import { useAdminUsers, useSystemFeatures } from "@/lib/api/system-queries";
import {
  isSystemIndex,
  SYSTEM_AREAS,
  SYSTEM_ROUTE,
  type SystemArea,
  systemAreaFor,
} from "@/lib/system/areas";
import { SYSTEM_SCOPE_NOTE } from "@/lib/system/pages";

/**
 * The frame around every System page: the header, the list of areas, and the chosen area's
 * sheet. A wide screen shows the list beside the sheet, and `/system` itself opens the first
 * area. A phone shows one or the other: `/system` is the list, an area's own URL is its sheet
 * with a way back.
 */
export function SystemShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const index = isSystemIndex(pathname);
  const current = systemAreaFor(pathname);
  return (
    <>
      <PageHeader
        breadcrumbs={<ListSheetTrail title="System" href={SYSTEM_ROUTE} index={index} />}
      />
      <ListSheet index={index} list={<SystemAreaList currentId={current.id} />}>
        {children}
      </ListSheet>
    </>
  );
}

/**
 * The list of areas. An area that can be turned off ends in an On or Off dot, Users in its
 * count, and an area with work in progress in a spinner (with a percentage where one is known)
 * or a warning mark.
 */
function SystemAreaList({ currentId }: { currentId: string }) {
  const activity = useSystemActivity();
  const features = useSystemFeatures();
  const office = useSystemOffice();
  const ai = useSystemAi();
  const users = useAdminUsers();

  /** Whether an area that can be turned off is on. `undefined` while that is not known yet. */
  function enabled(area: SystemArea): boolean | undefined {
    if (area.feature !== undefined) return features.data?.configuration.values[area.feature];
    if (area.id === "office") return office.data?.configuration.enabled;
    if (area.id === "ai") {
      const configuration = ai.data?.configuration;
      return configuration === undefined ? undefined : configuration.organize || configuration.chat;
    }
    return undefined;
  }

  return (
    <AreaList
      title="System"
      label="System areas"
      items={SYSTEM_AREAS}
      currentId={currentId}
      footer={SYSTEM_SCOPE_NOTE}
      renderEnd={(item) => {
        const area = item as SystemArea;
        const section = area.activity;
        const entry =
          section === undefined
            ? undefined
            : activity.data?.items.find((candidate) => candidate.id === section);
        const pending = section !== undefined && activity.pending.has(section);
        const stale = activity.isError && area.feature !== undefined;
        const live = <AreaActivity entry={entry} pending={pending} stale={stale} />;
        const on = enabled(area);
        return (
          <>
            {live}
            {area.id === "users" && users.data !== undefined ? (
              <span className="font-normal text-muted-foreground text-xs tabular-nums">
                {users.data.users.length}
              </span>
            ) : null}
            {on === undefined ? null : (
              <StatusDot tone={on ? "success" : "off"} label={on ? "On" : "Off"} />
            )}
          </>
        );
      }}
    />
  );
}

/** Work in progress on an area's row, or a mark that it needs a look. Nothing when it is idle. */
function AreaActivity({
  entry,
  pending,
  stale,
}: {
  entry: SystemActivityItem | undefined;
  pending: boolean;
  stale: boolean;
}) {
  const busy = pending || (!stale && entry?.state === "working");
  const warning = !pending && (stale || entry?.warning === true || entry?.state === "waiting");
  if (!busy && !warning) return null;
  const detail = pending
    ? "Starting…"
    : stale
      ? "Activity status unavailable. Waiting for a fresh update."
      : (entry?.detail ?? "");
  const percent = busy && !pending && !stale ? entry?.percent : null;
  return (
    <span
      title={detail}
      data-system-activity={busy ? "working" : "warning"}
      className="flex shrink-0 items-center gap-1 font-normal text-muted-foreground text-xs tabular-nums"
    >
      {busy ? (
        <LoaderCircle
          aria-hidden="true"
          className="size-3.5 animate-spin motion-reduce:animate-none"
        />
      ) : (
        <CircleAlert aria-hidden="true" className="size-3.5 text-warning" />
      )}
      {percent != null ? <span>{percent}%</span> : null}
      <span className="sr-only">{detail}</span>
    </span>
  );
}
