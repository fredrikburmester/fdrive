"use client";

import type { SystemActivityItem } from "@fdrive/contracts";
import {
  Archive,
  ChevronRight,
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
  Sparkles,
  ToggleRight,
} from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import { useSystemActivity } from "@/lib/api/activity-queries";
import { readSidebarSectionOpen, writeSidebarSectionOpen } from "@/lib/metadata/sidebar-sections";
import { AI_PAGE, FEATURE_PAGES, OFFICE_PAGE } from "@/lib/system/pages";
import { cn } from "@/lib/utils";

const FEATURES_ITEM = {
  id: "features",
  href: "/system/features",
  label: "Features",
  Icon: ToggleRight,
} as const;
const SYSTEM_ITEMS = [
  { id: "backups", href: "/system/backups", label: "Backups", Icon: Archive },
  { id: "general", href: "/system/general", label: "General", Icon: Settings2 },
  { id: "storage", href: "/system/storage", label: "Storage", Icon: HardDrive },
] as const;
const FEATURE_ITEMS = [
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
  { id: "ai", ...AI_PAGE, Icon: Sparkles },
] as const;

type NavItem =
  | typeof FEATURES_ITEM
  | (typeof SYSTEM_ITEMS)[number]
  | (typeof FEATURE_ITEMS)[number];

function SystemNavLink({
  item,
  activity,
  pending,
  stale,
}: {
  item: NavItem;
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
      className={item.id === "features" ? "pr-8" : undefined}
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
    <>
      {button}
      {decorated && (
        <span id={descriptionId} className="sr-only">
          {detail}
        </span>
      )}
    </>
  );
}

export function SystemNav() {
  const query = useSystemActivity();
  const pathname = usePathname();
  const [open, setOpen] = useState(true);

  useEffect(() => {
    setOpen(
      pathname === FEATURES_ITEM.href ||
        FEATURE_ITEMS.some((item) => item.href === pathname) ||
        readSidebarSectionOpen(window.localStorage, "features"),
    );
  }, [pathname]);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    writeSidebarSectionOpen(window.localStorage, "features", next);
  }

  function link(item: NavItem) {
    return (
      <SystemNavLink
        item={item}
        activity={query.data?.items.find((entry) => entry.id === item.id)}
        pending={
          (item.id !== "backups" && item.id !== "ai" && query.pending.has(item.id)) ||
          (item.id === "features" &&
            FEATURE_ITEMS.some(({ id }) => id !== "ai" && query.pending.has(id)))
        }
        stale={
          query.isError &&
          !["general", "storage", "sharedFolders", "backups", "ai"].includes(item.id)
        }
      />
    );
  }

  return (
    <SidebarMenu>
      {SYSTEM_ITEMS.map((item) => (
        <SidebarMenuItem key={item.id}>{link(item)}</SidebarMenuItem>
      ))}
      <SidebarMenuItem>
        <Collapsible open={open} onOpenChange={handleOpenChange}>
          {link(FEATURES_ITEM)}
          <CollapsibleTrigger
            render={<SidebarMenuAction />}
            aria-label={open ? "Collapse Features" : "Expand Features"}
          >
            <ChevronRight
              className={cn(
                "transition-transform motion-reduce:transition-none",
                open && "rotate-90",
              )}
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <SidebarMenuSub className="mr-0 pr-0">
              {FEATURE_ITEMS.map((item) => (
                <SidebarMenuSubItem key={item.id}>{link(item)}</SidebarMenuSubItem>
              ))}
            </SidebarMenuSub>
          </CollapsibleContent>
        </Collapsible>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
