import { LockIcon } from "lucide-react";

/** How a trashed item reads: its name, null for an encrypted one this browser cannot read, and its original folder. */
export interface TrashLabel {
  readonly name: string | null;
  readonly folder: string;
}

/** What stands in for the name of an item this browser cannot read. */
export const ENCRYPTED_ITEM = "Encrypted item";

/** A trashed item's name, or "Encrypted item" with a lock where it cannot be read. */
export function TrashName({ label }: { label: TrashLabel }) {
  if (label.name !== null) return label.name;
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <LockIcon className="size-3.5" aria-hidden="true" />
      {ENCRYPTED_ITEM}
    </span>
  );
}
