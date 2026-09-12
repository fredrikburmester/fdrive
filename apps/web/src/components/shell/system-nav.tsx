"use client";

import type { SystemActivityId, SystemActivityItem } from "@fdrive/contracts";
import {
  CircleAlert,
  Database,
  FileText,
  FolderSymlink,
  HardDrive,
  Image,
  Images,
  LoaderCircle,
  ScanText,
  Search,
  Settings2,
  ToggleRight,
} from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useId } from "react";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { useSystemActivity } from "@/lib/api/activity-queries";
import { FEATURE_PAGES, OFFICE_PAGE } from "@/lib/system/pages";

const ITEMS = [
  { id: "features", href: "/system/features", label: "Features", Icon: ToggleRight },
  { id: "general", href: "/system/general", label: "General", Icon: Settings2 },
  { id: "storage", href: "/system/storage", label: "Storage", Icon: HardDrive },
  {
    id: "sharedFolders",
    href: "/system/shared-folders",
    label: "Shared folders",
    Icon: FolderSymlink,
  },
  { id: "thumbnails", ...FEATURE_PAGES.thumbnails, Icon: Image },
  { id: "textSearch", ...FEATURE_PAGES.textSearch, Icon: Database },
  { id: "semanticSearch", ...FEATURE_PAGES.semanticSearch, Icon: Search },
  { id: "pdfOcr", ...FEATURE_PAGES.pdfOcr, Icon: ScanText },
  { id: "imageSearch", ...FEATURE_PAGES.imageSearch, Icon: Images },
  { id: "office", ...OFFICE_PAGE, Icon: FileText },
] as const;

export function SystemNavItem({
  item,
  activity,
  pending,
  stale,
}: {
  item: (typeof ITEMS)[number];
  activity: SystemActivityItem | undefined;
  pending: boolean;
  stale: boolean;
}) {
  const pathname = usePathname();
  const descriptionId = useId();
  const busy = pending || (!stale && activity?.state === "working");
  const warning = !pending && (stale || activity?.warning || activity?.state === "waiting");
  const percent = busy && !pending && !stale ? activity?.percent : null;
  const detail = pending
    ? "Starting…"
    : stale
      ? "Activity status unavailable. Waiting for a fresh update."
      : (activity?.detail ?? "");
  const decorated = busy || warning;
  const button = (
    <SidebarMenuButton
      isActive={pathname === item.href}
      render={<Link href={item.href as Route} />}
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
      <item.Icon />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {decorated && (
        <span
          aria-hidden="true"
          className="ml-auto flex shrink-0 items-center gap-1 text-xs tabular-nums text-muted-foreground"
          data-system-activity={busy ? "working" : "warning"}
        >
          {busy ? (
            <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" />
          ) : (
            <CircleAlert className="size-3" />
          )}
          {percent != null && <span>{percent}%</span>}
        </span>
      )}
    </SidebarMenuButton>
  );
  return (
    <SidebarMenuItem>
      {button}
      {decorated && (
        <span id={descriptionId} className="sr-only">
          {detail}
        </span>
      )}
    </SidebarMenuItem>
  );
}

export function SystemNav() {
  const query = useSystemActivity();
  const featureIds: SystemActivityId[] = [
    "thumbnails",
    "textSearch",
    "semanticSearch",
    "pdfOcr",
    "imageSearch",
  ];
  return (
    <SidebarMenu>
      {ITEMS.map((item) => (
        <SystemNavItem
          key={item.id}
          item={item}
          activity={query.data?.items.find((entry) => entry.id === item.id)}
          pending={
            query.pending.has(item.id) ||
            (item.id === "features" && featureIds.some((id) => query.pending.has(id)))
          }
          stale={query.isError && !["general", "storage", "sharedFolders"].includes(item.id)}
        />
      ))}
    </SidebarMenu>
  );
}
