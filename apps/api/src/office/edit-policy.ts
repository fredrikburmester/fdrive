import { isOfficePath, type OfficeSettings } from "@fdrive/contracts";
import type { LocalGrantService } from "../local/grants.js";
import type { OfficeDeps } from "./types.ts";

/**
 * Who may open a document for editing: one of the editors chosen on
 * System > Office, while Office and editing are on, and never in a folder
 * shared with them to view only, where a save would be refused. Each save
 * still needs the saving login's own write access.
 */
export function createOfficeEditPolicy(deps: {
  readonly settings: () => Promise<OfficeSettings>;
  readonly grants: Pick<LocalGrantService, "isReadOnly">;
}): NonNullable<OfficeDeps["canEdit"]> {
  return async (actor, path) => {
    if (!isOfficePath(path)) return false;
    const settings = await deps.settings();
    if (!settings.enabled || !settings.editingEnabled) return false;
    if (!settings.editorUsernames.includes(actor.identity.externalUsername)) return false;
    return !(await deps.grants.isReadOnly(actor.identity, path));
  };
}
