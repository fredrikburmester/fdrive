import type { PersonalActivityEvent } from "@fdrive/contracts";
import { baseName, isRoot, parentPath } from "@fdrive/core";

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

/** The Result column: "Recent" for a read not yet settled, the outcome, or "Started". */
export function activityResult(event: PersonalActivityEvent): string {
  return event.provisional ? "Recent" : (event.outcome ?? "Started");
}

/** Whether the result deserves the reader's attention: the action did not go through. */
export function activityFailed(event: PersonalActivityEvent): boolean {
  return event.outcome === "failed" || event.outcome === "denied";
}

/** What the feed holds, for the bar under the header: "12 events", or "50+ events" with more to load. */
export function eventCountLabel(count: number, more: boolean): string {
  return `${count}${more ? "+" : ""} ${count === 1 && !more ? "event" : "events"}`;
}
