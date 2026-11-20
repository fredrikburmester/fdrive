"use client";

import { LayoutGridIcon, ListIcon, ListTreeIcon } from "lucide-react";
import { PageSection, SettingRow } from "@/components/shell/page-layout";
import { ChoiceRow } from "@/components/shell/setting-controls";
import { Button } from "@/components/ui/button";
import { useResetFolderViews } from "@/lib/files/folder-view-queries";
import { ROW_CLICK_ACTIONS, type RowClickAction } from "@/lib/files/row-click";
import { useDefaultView } from "@/lib/files/use-default-view";
import { useRowClickAction } from "@/lib/files/use-row-click";
import type { ViewMode } from "@/lib/files/view-mode";

const ROW_CLICK_LABELS: Record<RowClickAction, string> = {
  select: "Select",
  toggle: "Toggle selection",
  highlight: "Highlight",
  open: "Open",
};

const ROW_CLICK_HINTS: Record<RowClickAction, string> = {
  select: "A click selects just that item; double-click or Enter opens it.",
  toggle: "A click adds or removes the item from the selection, like its checkbox.",
  highlight:
    "A click outlines the item without selecting it; Enter or double-click opens it, and the checkbox or Cmd/Ctrl-click selects.",
  open: "A click opens the item; use the checkbox or Cmd/Ctrl-click to select.",
};

const VIEW_MODES: readonly ViewMode[] = ["list", "grid", "tree"];
const VIEW_MODE_LABELS: Record<ViewMode, string> = { list: "List", grid: "Grid", tree: "Tree" };
const VIEW_MODE_ICONS = { list: ListIcon, grid: LayoutGridIcon, tree: ListTreeIcon };

/**
 * Settings > Browsing: what a click on a row does, the view a folder opens in, and a reset for
 * the views saved per folder.
 */
export function BrowsingSection() {
  const [rowClick, setRowClick] = useRowClickAction();
  const [mode, setMode] = useDefaultView();
  const reset = useResetFolderViews();
  return (
    <>
      <PageSection title="Browsing" description="How listings respond to clicks in this browser.">
        <ChoiceRow
          label="Row click"
          hint={ROW_CLICK_HINTS[rowClick]}
          value={rowClick}
          options={ROW_CLICK_ACTIONS}
          labels={ROW_CLICK_LABELS}
          onChange={setRowClick}
        />
      </PageSection>
      <PageSection
        title="Folder views"
        description="Changing View or Sort in a folder remembers it for that login across devices."
      >
        <ChoiceRow
          label="Default view"
          hint="Used in this browser for folders without a saved view and for virtual listings."
          value={mode}
          options={VIEW_MODES}
          labels={VIEW_MODE_LABELS}
          icons={VIEW_MODE_ICONS}
          onChange={setMode}
        />
        <SettingRow
          label="Saved views"
          description="Remove every saved view and sort. All folders will follow the defaults."
        >
          <Button variant="outline" disabled={reset.isPending} onClick={() => reset.mutate()}>
            {reset.isPending ? "Resetting…" : "Reset all folder views"}
          </Button>
        </SettingRow>
      </PageSection>
    </>
  );
}
