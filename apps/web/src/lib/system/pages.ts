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
 * What a System page's settings apply to. Everything under System is
 * installation-wide except the per-server settings on Storage (the servers
 * themselves and their Trash). Each page header states its scope with these
 * words, and the sidebar caption says the section is for administrators, so
 * the label being browsed never suggests a page follows the active login.
 */
export type SystemScope = "server" | "storage";
export const SYSTEM_SCOPE_CAPTION = "Admins only";
export const SYSTEM_SCOPE_NOTES: Record<SystemScope, string> = {
  server:
    "Installation-wide. Applies to every storage server and login, not just the one you are browsing.",
  storage:
    "Per storage server. Each server keeps its own settings, including Trash, whichever login you are browsing as.",
};
