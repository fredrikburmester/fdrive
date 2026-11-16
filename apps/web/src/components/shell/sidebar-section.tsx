"use client";

import { cn } from "cn";
import { type ComponentProps, type ReactNode, useEffect, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { SidebarGroup } from "@/components/ui/sidebar";
import {
  readSidebarSectionOpen,
  type SidebarSectionKey,
  writeSidebarSectionOpen,
} from "@/lib/metadata/sidebar-sections";

/**
 * The look of a row in the sidebar, on top of `SidebarMenuButton`'s: 36px
 * tall, 15px text and 18px icons, and a selected row that only takes the
 * accent background, never bold text.
 */
export const SIDEBAR_ROW = "h-9 gap-3 text-[15px] data-active:font-normal [&_svg]:size-[18px]";

/** A muted line standing in for a section's rows while it has none. */
export const SIDEBAR_NOTE = "px-3 py-1 text-xs text-sidebar-foreground/50";

const LABEL =
  "flex h-8 w-full min-w-0 items-center gap-1.5 rounded-sm px-3 text-left text-[13px] font-medium text-sidebar-foreground/70";

/** A section's name over its rows, for a section that is always open. */
export function SidebarSectionLabel({ className, ...props }: ComponentProps<"div">) {
  return <div data-sidebar="section-label" className={cn(LABEL, className)} {...props} />;
}

/** The small triangle after a section's name: down while it is open. */
function Caret({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 10 10"
      aria-hidden="true"
      className={cn("size-2.5 shrink-0 fill-current transition-transform", !open && "-rotate-90")}
    >
      <path d="M2 3.5h6L5 7z" />
    </svg>
  );
}

/**
 * A sidebar section whose name opens and shuts it. Whether it is open is kept
 * in this browser per `section`, and it starts open.
 */
export function SidebarSection({
  section,
  label,
  children,
}: {
  section: SidebarSectionKey;
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);

  useEffect(() => {
    setOpen(readSidebarSectionOpen(window.localStorage, section));
  }, [section]);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    writeSidebarSectionOpen(window.localStorage, section, next);
  }

  return (
    <SidebarGroup className="py-0">
      <Collapsible open={open} onOpenChange={handleOpenChange}>
        <CollapsibleTrigger
          className={cn(
            LABEL,
            "outline-hidden select-none hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-sidebar-ring",
          )}
        >
          <span className="truncate">{label}</span>
          <Caret open={open} />
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-0.5">{children}</CollapsibleContent>
      </Collapsible>
    </SidebarGroup>
  );
}
