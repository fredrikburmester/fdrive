"use client";

import { baseName } from "@fdrive/core";
import type { Ref } from "react";
import { DetailSheet } from "@/components/shell/list-sheet";
import { PageSection } from "@/components/shell/page-layout";
import { PHONE_TARGET } from "@/components/shell/page-rows";
import { Code, type Fact, FactList } from "@/components/shell/sheet-data";
import { StatusBadge } from "@/components/shell/status";
import { Button } from "@/components/ui/button";
import { useActivityFile } from "@/lib/activity/queries";
import { closeOnEscape } from "./event-sheet";
import { fileAvailability } from "./history-rows";
import { JourneyDetails } from "./journey-details";

export interface JourneySummaryProps {
  fileId: string;
  /** Whether the file's sheet is open beside the table. */
  detailsOpen: boolean;
  onDetails: () => void;
  /** The button that opens the file's sheet, which gets focus back when the sheet closes. */
  detailsRef?: Ref<HTMLButtonElement>;
}

/**
 * The file a journey page is about, above its events: its name, where it is now, whether it can
 * be reached, and the way to its related files and revision records in a sheet.
 */
export function JourneySummary({
  fileId,
  detailsOpen,
  onDetails,
  detailsRef,
}: JourneySummaryProps) {
  const summary = useActivityFile(fileId);
  if (summary.isPending) {
    return (
      <p role="status" className="border-border border-b px-3 py-2 text-muted-foreground text-xs">
        Finding the current location…
      </p>
    );
  }
  if (summary.isError) {
    return (
      <p role="alert" className="border-border border-b px-3 py-2 text-destructive text-sm">
        {summary.error.message}
      </p>
    );
  }
  const file = summary.data;
  const availability = fileAvailability(file.availability);
  return (
    <PageSection
      title={<span className="break-all">{baseName(file.lastKnownPath)}</span>}
      description={<span className="break-all">{file.currentPath ?? file.lastKnownPath}</span>}
      actions={
        <>
          <StatusBadge tone={availability.tone}>{availability.label}</StatusBadge>
          <Button
            ref={detailsRef}
            variant="outline"
            size="sm"
            className={PHONE_TARGET}
            aria-expanded={detailsOpen}
            onClick={onDetails}
          >
            File details
          </Button>
        </>
      }
    >
      <p className="px-3 py-2 text-muted-foreground text-xs">
        {file.label && `${file.label} · `}Revision records describe changes; earlier file contents
        are not stored.
      </p>
    </PageSection>
  );
}

export interface JourneyFileSheetProps {
  fileId: string;
  onClose: () => void;
  ref?: Ref<HTMLElement>;
}

/**
 * The file a journey page is about, in detail and docked beside its events: where it is, whose
 * login recorded it, the files copied or derived from it and its revision records.
 */
export function JourneyFileSheet({ fileId, onClose, ref }: JourneyFileSheetProps) {
  const file = useActivityFile(fileId).data;
  if (file === undefined) return null;
  const availability = fileAvailability(file.availability);
  const facts: Fact[] = [
    file.currentPath
      ? { label: "Location", value: <Code>{file.currentPath}</Code> }
      : { label: "Last seen at", value: <Code>{file.lastKnownPath}</Code> },
    { label: "Kind", value: file.kind === "dir" ? "Folder" : "File" },
  ];
  if (file.label) facts.push({ label: "Login", value: file.label });
  if (file.lastConfirmedAt) {
    facts.push({
      label: "Last confirmed",
      value: new Date(file.lastConfirmedAt).toLocaleString(),
    });
  }
  return (
    <DetailSheet
      ref={ref}
      tabIndex={-1}
      data-activity-sheet="file"
      width="docked"
      titleAs="h2"
      title={baseName(file.lastKnownPath)}
      badges={<StatusBadge tone={availability.tone}>{availability.label}</StatusBadge>}
      onClose={onClose}
      onKeyDown={closeOnEscape(onClose)}
      className="outline-none"
    >
      <PageSection title="File">
        <FactList facts={facts} />
      </PageSection>
      <JourneyDetails fileId={fileId} />
    </DetailSheet>
  );
}
