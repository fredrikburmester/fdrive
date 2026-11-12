"use client";

import type { ReactNode } from "react";
import { SearchButton } from "@/components/search/search-button";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useMe } from "@/lib/api/auth-queries";

/**
 * The signed-in account, as seen from inside the shell. Thin re-export of
 * `useMe` so shell components have a single, obviously-shell-scoped hook to
 * import, rather than reaching into `@/lib/api/auth-queries` directly.
 */
export function useShellMe() {
  return useMe();
}

export interface PageHeaderProps {
  /** Typically a `Breadcrumb` built by the calling route. */
  breadcrumbs?: ReactNode;
  /** Page-specific controls, right-aligned (buttons, view toggles, and so on). */
  actions?: ReactNode;
}

/**
 * Sticky top bar shared by every page inside the shell: the sidebar
 * trigger, a slot for breadcrumbs, and a slot for right-aligned actions.
 */
export function PageHeader({ breadcrumbs, actions }: PageHeaderProps) {
  return (
    <header className="sticky top-0 z-10 flex h-12 min-w-0 shrink-0 items-center gap-2 border-b border-border bg-background/80 px-3 backdrop-blur-md">
      <SidebarTrigger />
      <Separator orientation="vertical" className="h-4" />
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">{breadcrumbs}</div>
      <div className="flex shrink-0 items-center gap-2">
        <SearchButton />
        {actions}
      </div>
    </header>
  );
}
