"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { AreaList, ListSheet, ListSheetTrail } from "@/components/shell/list-sheet";
import { PageHeader, useShellMe } from "@/components/shell/page-header";
import {
  isSettingsIndex,
  SETTINGS_ROUTE,
  settingsSectionFor,
  settingsSectionsFor,
} from "./sections";

/**
 * The frame around every `/account` page: the header, the list of sections, and the open
 * section's sheet. A wide screen shows the list beside the sheet, and `/account` itself opens the
 * first section. A phone shows one or the other: `/account` is the list, a section's own URL is
 * its sheet with a way back.
 */
export function SettingsShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { data: me } = useShellMe();
  const index = isSettingsIndex(pathname);
  const current = settingsSectionFor(pathname);
  return (
    <>
      <PageHeader
        breadcrumbs={<ListSheetTrail title="Settings" href={SETTINGS_ROUTE} index={index} />}
      />
      <ListSheet
        index={index}
        list={
          <AreaList
            title="Settings"
            label="Settings sections"
            items={settingsSectionsFor(me)}
            currentId={current.id}
          />
        }
      >
        {children}
      </ListSheet>
    </>
  );
}
