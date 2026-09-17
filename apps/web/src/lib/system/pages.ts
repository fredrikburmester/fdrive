import type { FeatureId } from "@fdrive/contracts";
import type { Route } from "next";

export interface SystemPageLink {
  readonly href: Route;
  readonly label: string;
}

/**
 * Where each feature's own System page lives. The Features cards link here
 * ("Open {label}"), and the sidebar builds its System group from the same
 * table, so a route rename cannot leave the two disagreeing.
 *
 * Full-text search and search OCR are both the indexer's work, so they
 * share the Indexer page.
 */
export const FEATURE_PAGES: Record<FeatureId, SystemPageLink> = {
  thumbnails: { href: "/system/thumbnails" as Route, label: "Thumbnails" },
  textSearch: { href: "/system/indexer" as Route, label: "Full-text search" },
  searchOcr: { href: "/system/indexer" as Route, label: "Full-text search" },
  semanticSearch: { href: "/system/search" as Route, label: "Semantic search" },
  imageSearch: { href: "/system/image-search" as Route, label: "Image search" },
  pdfOcr: { href: "/system/ocr" as Route, label: "Searchable PDFs" },
};

/**
 * Office is not a `FeatureId` (it keeps its own settings record and status),
 * but it has a page in the same System group.
 */
export const OFFICE_PAGE: SystemPageLink = { href: "/system/office" as Route, label: "Office" };

/** AI keeps its own settings record too, and lives in the same group. */
export const AI_PAGE: SystemPageLink = { href: "/system/ai" as Route, label: "AI" };

/**
 * The System section describes the whole server: its counts, activity and
 * actions cover every storage and login, never just the one being browsed.
 * The sidebar caption and every page header say so with the same words, so
 * the two can never disagree about what they show.
 */
export const SYSTEM_SCOPE_CAPTION = "Whole server · admins only";
export const SYSTEM_SCOPE_NOTE =
  "Applies to the whole server, not just the storage you are browsing. Admins only.";
