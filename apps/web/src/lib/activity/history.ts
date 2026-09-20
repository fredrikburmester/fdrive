import type { PersonalActivityEvent } from "@fdrive/contracts";

export const activityLabels: Record<PersonalActivityEvent["action"], string> = {
  "file.upload": "Uploaded",
  "file.create": "Created file",
  "file.save": "Saved",
  "folder.create": "Created folder",
  "file.rename": "Renamed",
  "file.move": "Moved",
  "file.copy": "Copied",
  "file.trash": "Moved to Trash",
  "file.restore": "Restored",
  "file.delete": "Deleted permanently",
  "trash.empty": "Emptied Trash",
  "file.open": "Opened",
  "file.preview": "Previewed",
  "file.inspect": "Viewed info",
  "file.read": "Read content",
  "file.download": "Downloaded",
  "file.materialize": "Downloaded to device",
  "file.reveal": "Shown in folder",
  "archive.inspect": "Browsed archive",
  "archive.compress": "Created archive",
  "archive.extract": "Extracted archive",
  "share.create": "Created share",
  "share.update": "Updated share",
  "share.revoke": "Revoked share",
  "share.copy_link": "Copied share link",
  "file.tags.set": "Changed tags",
  "tag.update": "Updated tag",
  "tag.delete": "Deleted tag",
  "file.favorite.set": "Changed favorite",
  "folder.view.set": "Pinned folder view",
  "folder.view.reset": "Reset folder view",
  "observation.location_missing": "Unknown event · File missing",
  "observation.location_changed": "Unknown event · Location changed",
  "observation.left_scope": "Unknown event · Left this location",
  "observation.content_changed": "Unknown event · Content changed",
  "observation.continuity_unknown": "Unknown event · Continuity uncertain",
  "observation.resolved": "Unknown event resolved",
};
/** A finished operation replaces its earlier intent even when they arrived on different pages. */
export function collapseActivity(
  events: readonly PersonalActivityEvent[],
): PersonalActivityEvent[] {
  const selected = new Map<string, PersonalActivityEvent>();
  for (const event of events) {
    const key = event.operationId ?? event.id;
    const previous = selected.get(key);
    if (
      !previous ||
      (previous.stage === "intent" && event.stage !== "intent") ||
      (previous.provisional && !event.provisional)
    )
      selected.set(key, event);
  }
  return [...selected.values()].sort(
    (a, b) => b.sortAt.localeCompare(a.sortAt) || b.id.localeCompare(a.id),
  );
}
export function activityPath(event: PersonalActivityEvent): string | null {
  return (
    event.after?.targetPath ??
    event.after?.path ??
    event.subjects.find((subject) => subject.role === "target")?.path ??
    event.before?.path ??
    event.subjects[0]?.path ??
    null
  );
}
