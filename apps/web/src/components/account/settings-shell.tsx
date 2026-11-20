"use client";

import { cn } from "cn";
import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { PageHeader, useShellMe } from "@/components/shell/page-header";
import { PageBody } from "@/components/shell/page-layout";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { buttonVariants } from "@/components/ui/button";
import {
  isSettingsIndex,
  SETTINGS_ROUTE,
  type SettingsSection,
  settingsSectionFor,
  settingsSectionsFor,
} from "./sections";
import { SettingsNav } from "./settings-nav";

/**
 * The frame around every `/account` page: the header, the section list, and the open section.
 *
 * A wide screen shows the list beside the section, and `/account` itself opens the first one.
 * A phone shows one or the other: `/account` is the list, a section's own URL is that section
 * with a way back to the list. Which of the two shows is decided in CSS from the URL, so the
 * server render already matches the screen.
 */
export function SettingsShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { data: me } = useShellMe();
  const index = isSettingsIndex(pathname);
  const current = settingsSectionFor(pathname);

  return (
    <>
      <PageHeader breadcrumbs={<SettingsTrail section={current} index={index} />} />
      <PageBody className="md:flex-row">
        <SettingsNav
          sections={settingsSectionsFor(me)}
          currentId={current.id}
          className={cn(!index && "max-md:hidden")}
        />
        <div
          data-slot="settings-content"
          className={cn("flex min-w-0 flex-1 flex-col", index && "max-md:hidden")}
        >
          {children}
        </div>
      </PageBody>
    </>
  );
}

/** The phone header's title weight, as the file browser's folder name has there. */
const PHONE_TITLE = "max-md:px-1.5 max-md:font-semibold max-md:text-[15px]";

/**
 * The header's trail. Wide: "Settings > Section", like a folder's breadcrumb. Phone: "Settings"
 * over the section list, and inside a section a back button ahead of the section's name.
 */
function SettingsTrail({ section, index }: { section: SettingsSection; index: boolean }) {
  return (
    <Breadcrumb className="min-w-0 flex-1">
      <BreadcrumbList className="min-w-0 flex-nowrap">
        <BreadcrumbItem className="md:hidden">
          {index ? (
            <h1 className={cn("text-foreground", PHONE_TITLE)}>Settings</h1>
          ) : (
            // A real link, not a button rendered as one: it goes to a page.
            <Link
              href={SETTINGS_ROUTE}
              aria-label="Back to Settings"
              className={cn(
                buttonVariants({ variant: "ghost", size: "icon" }),
                "-ml-1 text-foreground",
              )}
            >
              <ChevronLeft aria-hidden="true" />
            </Link>
          )}
        </BreadcrumbItem>
        <BreadcrumbItem className="max-md:hidden">
          <BreadcrumbLink className="rounded-sm px-1" render={<Link href={SETTINGS_ROUTE} />}>
            Settings
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator className="max-md:hidden" />
        <BreadcrumbItem className={cn("min-w-0", index && "max-md:hidden")}>
          <h1
            aria-current="page"
            className={cn("truncate rounded-sm px-1 font-normal text-foreground", PHONE_TITLE)}
          >
            {section.label}
          </h1>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}
