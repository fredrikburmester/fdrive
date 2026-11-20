import type {
  ActivityFileResponse,
  PersonalActivityEvent,
  PersonalActivitySource,
} from "@fdrive/contracts";
import { baseName, isRoot, parentPath } from "@fdrive/core";
import type { StatusTone } from "@/components/shell/status";
import { activityLabels } from "@/lib/activity/history";

/** The events of one calendar day, as the history table groups them. */
export interface ActivityDay {
  /** The local date, stable across renders: `2026-11-20`. */
  readonly key: string;
  /** "Today", "Yesterday", or the date written out. */
  readonly label: string;
  readonly events: readonly PersonalActivityEvent[];
}

function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * How a day's group row reads relative to `now`: "Today", "Yesterday", then the weekday and
 * date, with the year only when it is not this one.
 */
export function dayLabel(date: Date, now: Date, locale?: string): string {
  if (dayKey(date) === dayKey(now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dayKey(date) === dayKey(yesterday)) return "Yesterday";
  return date.toLocaleDateString(locale, {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" as const }),
  });
}

/**
 * Splits events, already newest first, into the local calendar days they happened on. Days
 * keep the order of the events, so the newest day comes first.
 */
export function groupByDay(
  events: readonly PersonalActivityEvent[],
  now: Date = new Date(),
  locale?: string,
): ActivityDay[] {
  const days: { key: string; label: string; events: PersonalActivityEvent[] }[] = [];
  for (const event of events) {
    const date = new Date(event.sortAt);
    const key = dayKey(date);
    const last = days.at(-1);
    if (last !== undefined && last.key === key) {
      last.events.push(event);
    } else {
      days.push({ key, label: dayLabel(date, now, locale), events: [event] });
    }
  }
  return days;
}

/** The name an event's row shows for `path`: its last segment, or "Home" for the top folder. */
export function activityItemName(path: string): string {
  return baseName(path) || "Home";
}

/** The folder an event's item is in, for the Location column: "Home" at the top. */
export function activityFolder(path: string): string {
  const parent = parentPath(path);
  return isRoot(parent) ? "Home" : parent;
}

/**
 * Where an item came from, when the event moved or renamed it: the earlier name alone for a
 * rename within one folder, the earlier path otherwise. `null` when it did not move.
 */
export function activityOrigin(event: PersonalActivityEvent, path: string): string | null {
  const before = event.before?.path;
  if (before === undefined || before === path) return null;
  return parentPath(before) === parentPath(path) ? activityItemName(before) : before;
}

/** A recorded value as people read it: its words apart, the first one capitalized. */
export function sentenceCase(value: string): string {
  const words = value.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * What identifies an event's row while the page is open. An operation keeps its ID from intent
 * to outcome, so a chosen row stays chosen when the outcome replaces the intent.
 */
export function eventKey(event: PersonalActivityEvent): string {
  return event.operationId ?? event.id;
}

/** What happened, as the Action column and the event's sheet title say it: "Opened 3 times". */
export function activityAction(event: PersonalActivityEvent): string {
  return `${activityLabels[event.action]}${event.count > 1 ? ` ${event.count} times` : ""}`;
}

const SOURCE_LABELS: Record<PersonalActivitySource, string> = {
  web: "Web",
  api: "API",
  ai: "AI",
  office: "Office",
  mcp: "MCP",
  native: "Native app",
  indexer: "Indexer",
};

/** The Client column: where the action came from. */
export function activitySource(source: PersonalActivitySource): string {
  return SOURCE_LABELS[source];
}

/** The Result column: "Recent" for a read not yet settled, the outcome, or "Started". */
export function activityResult(event: PersonalActivityEvent): string {
  return event.provisional ? "Recent" : event.outcome ? sentenceCase(event.outcome) : "Started";
}

/**
 * How the result reads as a badge: green when it went through, red when it did not, amber when
 * only part of it did, and plain while it is unsettled or unknown.
 */
export function activityResultTone(event: PersonalActivityEvent): StatusTone {
  if (event.provisional) return "neutral";
  if (event.outcome === "success") return "success";
  if (activityFailed(event)) return "danger";
  if (event.outcome === "partial" || event.outcome === "conflict") return "warning";
  return "neutral";
}

/** Whether the result deserves the reader's attention: the action did not go through. */
export function activityFailed(event: PersonalActivityEvent): boolean {
  return event.outcome === "failed" || event.outcome === "denied";
}

/** What the feed holds, for the bar under the header: "12 events", or "50+ events" with more to load. */
export function eventCountLabel(count: number, more: boolean): string {
  return `${count}${more ? "+" : ""} ${count === 1 && !more ? "event" : "events"}`;
}

/** What an observation leaves uncertain, said wherever the event shows, so it is never hidden. */
export function uncertaintyNotes(event: PersonalActivityEvent): string[] {
  const notes: string[] = [];
  if (event.class === "observation") {
    notes.push("Detected outside a confirmed fdrive action. Who made this change is unknown.");
  }
  if (event.action === "observation.resolved") {
    notes.push(
      "The location can be read again. Whether this is the earlier file remains unknown; its new journey is under Files involved in the details.",
    );
  }
  return notes;
}

type Availability = ActivityFileResponse["availability"];

const AVAILABILITY: Record<Availability, { label: string; tone: StatusTone }> = {
  live: { label: "Live", tone: "success" },
  trashed: { label: "In Trash", tone: "neutral" },
  deleted: { label: "Deleted", tone: "off" },
  unknown: { label: "Unknown", tone: "warning" },
  unavailable: { label: "Unavailable", tone: "warning" },
};

/** Whether a journey's file can still be reached, as a word and the tone of its badge. */
export function fileAvailability(availability: Availability): { label: string; tone: StatusTone } {
  return AVAILABILITY[availability];
}
