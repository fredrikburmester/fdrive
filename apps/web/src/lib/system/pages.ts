import type { FeatureId } from "@fdrive/contracts";
import type { Route } from "next";

export interface SystemPageLink {
  readonly href: Route;
  readonly label: string;
}

/**
 * Where each feature's own System page lives. The list of System areas
 * (`areas.ts`) is built from the same table, so a route rename cannot leave
 * links to a feature and the list disagreeing.
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

/** The files folder's users; an installation-wide page beside General. */
export const USERS_PAGE: SystemPageLink = { href: "/system/users" as Route, label: "Users" };

/**
 * What every System area's settings apply to: the whole installation, never
 * just the login being browsed. The list of areas says so under its rows.
 */
export const SYSTEM_SCOPE_NOTE = "Admins only. Changes here apply to every user of this server.";
