import type { FsEntry, OfficeMode, OfficeStatusResponse } from "@fdrive/contracts";
import { previewKindFor } from "@/lib/preview/kind";

export const OFFICE_MODE_LABELS: Readonly<Record<OfficeMode, string>> = {
  view: "View in Office",
  edit: "Edit in Office",
  convert: "Convert and edit",
};

export function officeModesFor(
  entry: Pick<FsEntry, "name" | "kind">,
  status: OfficeStatusResponse | undefined,
  selectionCount = 1,
): OfficeMode[] {
  if (!status?.available || entry.kind !== "file" || selectionCount !== 1) return [];
  const extension = entry.name.includes(".")
    ? entry.name.slice(entry.name.lastIndexOf(".") + 1).toLowerCase()
    : "";
  return (["view", "edit", "convert"] as const).filter((mode) =>
    status.extensions[mode].some((ext) => ext.replace(/^\./, "").toLowerCase() === extension),
  );
}

export function isOfficePreviewCandidate(entry: FsEntry): boolean {
  const kind = previewKindFor(entry);
  return entry.kind === "file" && (kind === "office" || kind === "none");
}

export function opensInOffice(entry: FsEntry, status: OfficeStatusResponse | undefined): boolean {
  return isOfficePreviewCandidate(entry) && officeModesFor(entry, status).includes("view");
}
