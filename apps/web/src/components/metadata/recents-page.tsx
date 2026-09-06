"use client";

import { useState } from "react";
import { useRecents } from "@/lib/metadata/queries";
import { VirtualListing } from "./virtual-listing";

/**
 * The `/recents` page: the caller's recently opened paths, in a read-only
 * virtual listing. There is no server-side "un-recent" endpoint, so
 * removing a missing entry only hides it from this page's own local state
 * for the rest of the session; it reappears if the path is opened again.
 */
export function RecentsPage() {
  const { data: items } = useRecents();
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const paths = (items ?? []).map((item) => item.path).filter((path) => !removed.has(path));

  return (
    <VirtualListing
      title="Recents"
      paths={paths}
      onRemoveMissing={(path) => setRemoved((prev) => new Set(prev).add(path))}
    />
  );
}
