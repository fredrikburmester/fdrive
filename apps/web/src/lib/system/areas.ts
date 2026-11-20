import type { FeatureId, SystemActivityId } from "@fdrive/contracts";
import type { Route } from "next";
import { AI_PAGE, FEATURE_PAGES, OFFICE_PAGE, USERS_PAGE } from "./pages";

/** Where System lives. On a phone this URL is the list of areas; wider, it shows the first one. */
export const SYSTEM_ROUTE = "/system" as Route;

export type SystemAreaId =
  | "general"
  | "users"
  | "backups"
  | "thumbnails"
  | "textSearch"
  | "semanticSearch"
  | "pdfOcr"
  | "imageSearch"
  | "office"
  | "ai"
  | "about";

export interface SystemArea {
  readonly id: SystemAreaId;
  readonly label: string;
  readonly href: Route;
  /** One line under the label where the list is a screen of its own. */
  readonly description: string;
  /** The optional feature this area administers. Its row ends in an On or Off dot. */
  readonly feature?: FeatureId;
  /** The live-activity section whose work this area's row reports. */
  readonly activity?: SystemActivityId;
}

/** Every System area, in the order the list shows them. Each one's page is its sheet. */
export const SYSTEM_AREAS: readonly SystemArea[] = [
  {
    id: "general",
    label: "General",
    href: "/system/general" as Route,
    description: "Server address, trash and setup",
    activity: "general",
  },
  { id: "users", ...USERS_PAGE, description: "People who can sign in", activity: "users" },
  {
    id: "backups",
    label: "Backups",
    href: "/system/backups" as Route,
    description: "Destinations, schedule and restore",
  },
  {
    id: "thumbnails",
    ...FEATURE_PAGES.thumbnails,
    description: "Image and PDF previews",
    feature: "thumbnails",
    activity: "thumbnails",
  },
  {
    id: "textSearch",
    ...FEATURE_PAGES.textSearch,
    description: "Find files by name and contents",
    feature: "textSearch",
    activity: "textSearch",
  },
  {
    id: "semanticSearch",
    ...FEATURE_PAGES.semanticSearch,
    description: "Find documents by meaning",
    feature: "semanticSearch",
    activity: "semanticSearch",
  },
  {
    id: "pdfOcr",
    ...FEATURE_PAGES.pdfOcr,
    description: "Add a text layer to scanned PDFs",
    feature: "pdfOcr",
    activity: "pdfOcr",
  },
  {
    id: "imageSearch",
    ...FEATURE_PAGES.imageSearch,
    description: "Find images by what they show",
    feature: "imageSearch",
    activity: "imageSearch",
  },
  {
    id: "office",
    ...OFFICE_PAGE,
    description: "Edit documents in the browser",
    activity: "office",
  },
  { id: "ai", ...AI_PAGE, description: "The model behind chat and organize" },
  {
    id: "about",
    label: "About",
    href: "/system/about" as Route,
    description: "Version, links and guides",
  },
];

/** The area `/system` itself shows. */
export const FIRST_SYSTEM_AREA = SYSTEM_AREAS[0] as SystemArea;

/** True on `/system` itself: the first area on a wide screen, the list of areas on a phone. */
export function isSystemIndex(pathname: string | null): boolean {
  return pathname === SYSTEM_ROUTE || pathname === `${SYSTEM_ROUTE}/`;
}

/** The area a pathname shows; `/system` and anything unknown fall back to the first one. */
export function systemAreaFor(pathname: string | null): SystemArea {
  return (
    SYSTEM_AREAS.find((area) => pathname === area.href || pathname?.startsWith(`${area.href}/`)) ??
    FIRST_SYSTEM_AREA
  );
}
