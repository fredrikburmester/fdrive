"use client";

import { cn } from "cn";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useId } from "react";
import type { SettingsSection, SettingsSectionId } from "./sections";

export interface SettingsNavProps {
  sections: readonly SettingsSection[];
  /** The section on screen, highlighted on a wide screen. */
  currentId: SettingsSectionId;
  className?: string;
}

/**
 * The list of Settings sections. Beside the open section on a wide screen it is a narrow column
 * of rows like the app sidebar's, with the open one highlighted. On a phone it is a screen of
 * its own: full-width rows, each with a line saying what is inside and a chevron.
 */
export function SettingsNav({ sections, currentId, className }: SettingsNavProps) {
  return (
    <nav
      aria-label="Settings sections"
      data-slot="settings-nav"
      className={cn("shrink-0 border-border md:w-54 md:border-r", className)}
    >
      {/* Stays in view under the page header while a long section scrolls. */}
      <ul className="flex flex-col md:sticky md:top-12 md:gap-0.5 md:p-2">
        {sections.map((section) => (
          <li key={section.id}>
            <SettingsNavLink section={section} active={section.id === currentId} />
          </li>
        ))}
      </ul>
    </nav>
  );
}

function SettingsNavLink({ section, active }: { section: SettingsSection; active: boolean }) {
  const { label, description, href, Icon } = section;
  const id = useId();
  return (
    <Link
      href={href}
      // Named by the label alone at every width; the line under it is its description.
      aria-labelledby={`${id}-label`}
      aria-describedby={`${id}-description`}
      aria-current={active ? "page" : undefined}
      data-active={active ? "" : undefined}
      className={cn(
        "flex min-h-14 items-center gap-3 border-border/60 border-b px-3 py-2 text-[15px] outline-hidden ring-sidebar-ring focus-visible:ring-3 active:bg-sidebar-accent",
        "md:h-9 md:min-h-0 md:rounded-md md:border-b-0 md:px-2.5 md:py-0 md:hover:bg-sidebar-accent md:hover:text-sidebar-accent-foreground md:data-active:bg-sidebar-accent md:data-active:text-sidebar-accent-foreground",
      )}
    >
      <Icon
        aria-hidden="true"
        className="size-5 shrink-0 text-muted-foreground md:size-[18px] md:text-current"
      />
      <span className="min-w-0 flex-1">
        <span id={`${id}-label`} className="block truncate">
          {label}
        </span>
        <span
          id={`${id}-description`}
          className="block truncate text-muted-foreground text-xs md:hidden"
        >
          {description}
        </span>
      </span>
      <ChevronRight
        aria-hidden="true"
        className="size-4 shrink-0 text-muted-foreground/70 md:hidden"
      />
    </Link>
  );
}
