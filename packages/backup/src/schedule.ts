import type { BackupSchedule } from "@fdrive/contracts";

function wallTime(date: Date, timezone: string): { date: string; hour: number; weekday: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    weekday: get("weekday"),
  };
}
/** Search real UTC hours: DST gaps skip; repeated local hours share one schedule slot. */
export function nextSchedule(schedule: BackupSchedule, after: Date): Date | null {
  if (schedule.frequency === "manual") return null;
  const current = wallTime(after, schedule.timezone);
  for (let minutes = 1; minutes <= 9 * 24 * 60; minutes++) {
    const candidate = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + minutes * 60_000);
    const parts = new Intl.DateTimeFormat("en", {
      timeZone: schedule.timezone,
      minute: "2-digit",
    }).format(candidate);
    if (parts !== "00" && parts !== "0") continue;
    const local = wallTime(candidate, schedule.timezone);
    if (schedule.frequency === "hourly") {
      if (local.date !== current.date || local.hour !== current.hour) return candidate;
      continue;
    }
    if (local.date === current.date && current.hour >= schedule.hour) continue;
    if (local.hour >= schedule.hour && (schedule.frequency !== "weekly" || local.weekday === "Sun"))
      return candidate;
  }
  throw Error("Unable to resolve backup schedule");
}
export function retentionKeep<T extends { id: string; createdAt: string; pinned: boolean }>(
  items: T[],
  policy: BackupSchedule,
): Set<string> {
  const sorted = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const keep = new Set(sorted.filter((item) => item.pinned).map((item) => item.id));
  if (sorted[0]) keep.add(sorted[0].id);
  for (const [kind, limit] of [
    ["day", policy.daily],
    ["week", policy.weekly],
    ["month", policy.monthly],
  ] as const) {
    const slots = new Set<string>();
    for (const item of sorted) {
      const date = wallTime(new Date(item.createdAt), policy.timezone).date;
      const utc = new Date(`${date}T00:00:00Z`);
      const key =
        kind === "day"
          ? date
          : kind === "month"
            ? date.slice(0, 7)
            : String(Math.floor((utc.getTime() / 86_400_000 + 3) / 7));
      if (!slots.has(key) && slots.size < limit) {
        slots.add(key);
        keep.add(item.id);
      }
    }
  }
  return keep;
}
