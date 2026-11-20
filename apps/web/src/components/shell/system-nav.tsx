"use client";

import { CircleAlert, LoaderCircle, Server } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useId } from "react";
import { SIDEBAR_ROW } from "@/components/shell/sidebar-section";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { useSystemActivity } from "@/lib/api/activity-queries";
import { SYSTEM_ROUTE } from "@/lib/system/areas";

/** True when `pathname` is System or one of its areas. */
export function isSystemRoute(pathname: string | null): boolean {
  return pathname === SYSTEM_ROUTE || (pathname?.startsWith(`${SYSTEM_ROUTE}/`) ?? false);
}

/**
 * System's one row in the sidebar, for administrators. Its areas are listed on the System page
 * itself. The row reports work in any of them: a spinner while something runs, a warning mark
 * when an area needs a look or activity cannot be read.
 */
export function SystemNav() {
  const query = useSystemActivity();
  const pathname = usePathname();
  const descriptionId = useId();
  const items = query.data?.items ?? [];
  const working = items.filter((item) => item.state === "working");
  const busy = query.pending.size > 0 || (!query.isError && working.length > 0);
  const warning =
    !busy && (query.isError || items.some((item) => item.warning || item.state === "waiting"));
  const detail = query.isError
    ? "Activity status unavailable. Waiting for a fresh update."
    : busy
      ? working.map((item) => item.detail).join("\n") || "Starting…"
      : items
          .filter((item) => item.warning || item.state === "waiting")
          .map((item) => item.detail)
          .join("\n");
  const decorated = busy || warning;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        className={SIDEBAR_ROW}
        isActive={isSystemRoute(pathname)}
        render={<Link href={SYSTEM_ROUTE} />}
        aria-describedby={decorated ? descriptionId : undefined}
        {...(decorated
          ? {
              tooltip: {
                children: detail,
                hidden: false,
                role: "tooltip",
                className: "whitespace-pre-line",
              },
            }
          : {})}
      >
        <Server />
        <span className="min-w-0 flex-1 truncate">System</span>
        {decorated ? (
          <span
            aria-hidden="true"
            className="ml-auto flex shrink-0 items-center text-muted-foreground"
            data-system-activity={busy ? "working" : "warning"}
          >
            {busy ? (
              <LoaderCircle className="size-3! animate-spin motion-reduce:animate-none" />
            ) : (
              <CircleAlert className="size-3!" />
            )}
          </span>
        ) : null}
      </SidebarMenuButton>
      {decorated ? (
        <span id={descriptionId} className="sr-only">
          {detail}
        </span>
      ) : null}
    </SidebarMenuItem>
  );
}
