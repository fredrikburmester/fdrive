"use client";

import type { PersonalActivityEvent } from "@fdrive/contracts";
import { extensionOf } from "@fdrive/core";
import { cn } from "cn";
import { HelpCircle } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import type { KeyboardEvent, Ref } from "react";
import { FileIcon } from "@/components/files/file-icon";
import { DetailSheet } from "@/components/shell/list-sheet";
import { PageSection } from "@/components/shell/page-layout";
import { PHONE_TARGET } from "@/components/shell/page-rows";
import { Code, type Fact, FactList } from "@/components/shell/sheet-data";
import { StatusBadge } from "@/components/shell/status";
import { Button, buttonVariants } from "@/components/ui/button";
import { activityPath } from "@/lib/activity/history";
import { EventMembers } from "./event-members";
import {
  activityAction,
  activityItemName,
  activityResult,
  activityResultTone,
  activitySource,
  sentenceCase,
  uncertaintyNotes,
} from "./history-rows";
import { JourneyDetails } from "./journey-details";
import { useOpenActivityFile } from "./open-activity-file";

/** A link to another activity page, drawn like the buttons beside it. */
const PAGE_LINK = cn(buttonVariants({ variant: "outline" }), PHONE_TARGET);

/** Closes a docked sheet from the keyboard, wherever focus is inside it. */
export function closeOnEscape(onClose: () => void) {
  return (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onClose();
  };
}

/** The icon beside an event's item: its kind, or a question mark for an observation. */
export function ActivityItemIcon({ event, name }: { event: PersonalActivityEvent; name: string }) {
  if (event.class === "observation") {
    return <HelpCircle className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
  }
  const kind = event.after?.kind ?? event.before?.kind ?? "file";
  return <FileIcon kind={kind} ext={kind === "dir" ? "" : extensionOf(name)} mime={null} />;
}

/** The recorded facts of one event: where, when, and what it recorded before and after. */
function eventFacts(event: PersonalActivityEvent, path: string | null): Fact[] {
  const facts: Fact[] = [];
  const add = (label: string, value: Fact["value"]) => facts.push({ label, value });
  if (path) add("Path", <Code>{path}</Code>);
  if (event.before?.path && event.before.path !== path) {
    add("From", <Code>{event.before.path}</Code>);
  }
  add("When", new Date(event.sortAt).toLocaleString());
  add("Client", activitySource(event.source));
  add("Evidence", sentenceCase(event.evidence));
  add("Recorded", new Date(event.recordedAt).toLocaleString());
  if (event.lastConfirmedAt) {
    add("Last confirmed", new Date(event.lastConfirmedAt).toLocaleString());
  }
  if (event.after?.size !== undefined) add("Size", `${event.after.size.toLocaleString()} bytes`);
  if (event.errorCode) add("Result", sentenceCase(event.errorCode));
  if (event.after?.trashLeaf) add("Trash location", <Code>{event.after.trashLeaf}</Code>);
  for (const side of ["before", "after"] as const) {
    const recorded = event[side];
    if (!recorded) continue;
    const values = [
      recorded.tags && `Tags: ${recorded.tags.map((tag) => tag.name).join(", ") || "none"}`,
      recorded.favorite !== undefined && `Favorite: ${recorded.favorite ? "yes" : "no"}`,
      recorded.view && `Folder view: ${recorded.view}`,
      recorded.permissions && `Share permissions: ${recorded.permissions.join(", ")}`,
      recorded.expiresAt !== undefined &&
        `Share expiry: ${recorded.expiresAt ? new Date(recorded.expiresAt).toLocaleString() : "none"}`,
      recorded.completedCount !== undefined && `Completed: ${recorded.completedCount}`,
      recorded.failedCount !== undefined && `Failed: ${recorded.failedCount}`,
    ].filter(Boolean);
    if (values.length) add(side === "before" ? "Before" : "After", values.join(" · "));
  }
  if (event.firstAt && event.lastAt) {
    add(
      "Time range",
      `${new Date(event.firstAt).toLocaleTimeString()} – ${new Date(event.lastAt).toLocaleTimeString()}`,
    );
  }
  return facts;
}

export interface EventSheetProps {
  event: PersonalActivityEvent;
  /** The file whose journey the page shows, which needs no link to itself. */
  journeyFileId: string | undefined;
  onClose: () => void;
  ref?: Ref<HTMLElement>;
}

/**
 * One event in detail, docked beside the table: what happened as the title, the item it happened
 * to, how it ended, the ways on (open the file, show it in its folder, its journey, its batch),
 * then everything recorded about it, the files it touched and the file's own journey.
 */
export function EventSheet({ event, journeyFileId, onClose, ref }: EventSheetProps) {
  const { open, canOpen } = useOpenActivityFile(event);
  const path = activityPath(event);
  const name = path ? activityItemName(path) : null;
  const notes = uncertaintyNotes(event);
  return (
    <DetailSheet
      ref={ref}
      tabIndex={-1}
      data-activity-sheet="event"
      width="docked"
      titleAs="h2"
      title={activityAction(event)}
      lede={
        name === null ? undefined : (
          <span className="flex min-w-0 items-center gap-2 text-foreground">
            <ActivityItemIcon event={event} name={name} />
            <span className="min-w-0 [overflow-wrap:anywhere]">{name}</span>
          </span>
        )
      }
      badges={
        <>
          <StatusBadge tone={activityResultTone(event)}>{activityResult(event)}</StatusBadge>
          {event.evidence === "client_reported" && (
            <StatusBadge>Reported by your client</StatusBadge>
          )}
        </>
      }
      onClose={onClose}
      onKeyDown={closeOnEscape(onClose)}
      className="outline-none"
    >
      {notes.length > 0 && (
        <div className="flex flex-col gap-1.5 text-muted-foreground text-sm">
          {notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </div>
      )}
      {(event.fileId || event.batchId) && (
        <div data-slot="event-actions" className="flex flex-wrap items-center gap-2">
          {event.fileId && (
            <>
              <Button
                variant="outline"
                className={PHONE_TARGET}
                disabled={!canOpen}
                onClick={() => void open("file")}
              >
                Open
              </Button>
              <Button
                variant="outline"
                className={PHONE_TARGET}
                disabled={!canOpen}
                onClick={() => void open("reveal")}
              >
                Show in folder
              </Button>
              {event.fileId !== journeyFileId && (
                <Link href={`/activity/files/${event.fileId}` as Route} className={PAGE_LINK}>
                  File journey
                </Link>
              )}
            </>
          )}
          {event.batchId && (
            <Link href={`/activity/batches/${event.batchId}` as Route} className={PAGE_LINK}>
              View batch
            </Link>
          )}
        </div>
      )}
      <PageSection title="Details">
        <FactList facts={eventFacts(event, path)} />
      </PageSection>
      <EventMembers event={event} />
      {event.fileId && event.fileId !== journeyFileId && <JourneyDetails fileId={event.fileId} />}
    </DetailSheet>
  );
}
