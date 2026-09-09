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
  textSearch: { href: "/system/indexer" as Route, label: "Indexer" },
  searchOcr: { href: "/system/indexer" as Route, label: "Indexer" },
  semanticSearch: { href: "/system/search" as Route, label: "Search" },
  imageSearch: { href: "/system/image-search" as Route, label: "Image search" },
  pdfOcr: { href: "/system/ocr" as Route, label: "OCR" },
};

/**
 * Office is not a `FeatureId` (it keeps its own settings record and status),
 * but it has a page in the same System group.
 */
export const OFFICE_PAGE: SystemPageLink = { href: "/system/office" as Route, label: "Office" };
