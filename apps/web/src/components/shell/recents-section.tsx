"use client";

import { baseName } from "@fdrive/core";
import { ClockIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { SIDEBAR_NOTE, SIDEBAR_ROW, SidebarSection } from "@/components/shell/sidebar-section";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { viewHref } from "@/lib/metadata/deps";
import { useRecents } from "@/lib/metadata/queries";
import { sidebarSectionState } from "@/lib/metadata/sidebar-sections";
import { cn } from "@/lib/utils";

const MAX_VISIBLE = 8;
const RECENTS_ROUTE = "/recents" as Route;

function toRoute(href: string): Route {
  return href as Route;
}

/** The sidebar's "Recents" section: the last 8 opened files, each opening
 * its preview, plus a "Show all" link to `/recents`. Always renders once
 * loaded, even with nothing opened yet, showing a muted placeholder line
 * instead of disappearing. */
export function RecentsSection() {
  const { data: items } = useRecents();
  const state = sidebarSectionState(items);

  if (state === "loading") {
    return null;
  }

  const visible = (items ?? []).slice(0, MAX_VISIBLE);

  return (
    <SidebarSection section="recents" label="Recents">
      {state === "empty" ? (
        <p className={SIDEBAR_NOTE}>Files you open show up here</p>
      ) : (
        <SidebarMenu>
          {visible.map((item) => (
            <SidebarMenuItem key={item.path}>
              <SidebarMenuButton
                className={SIDEBAR_ROW}
                render={<Link href={toRoute(viewHref(item.path))} />}
              >
                <ClockIcon />
                <span className="truncate">{baseName(item.path)}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link href={RECENTS_ROUTE} />}
              className={cn(SIDEBAR_ROW, "text-sidebar-foreground/60")}
            >
              <span>Show all</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      )}
    </SidebarSection>
  );
}
