import type { MeResponse } from "@fdrive/contracts";
import {
  CalendarClock,
  KeyRound,
  LockKeyhole,
  type LucideIcon,
  MousePointerClick,
  Palette,
  RectangleEllipsis,
} from "lucide-react";
import type { Route } from "next";

/**
 * Where Settings lives. The routes keep the `/account` prefix the page had while it was called
 * Account, so links saved before the rename still open it.
 */
export const SETTINGS_ROUTE = "/account" as Route;

export type SettingsSectionId =
  | "appearance"
  | "browsing"
  | "formats"
  | "password"
  | "encryption"
  | "tokens";

export interface SettingsSection {
  readonly id: SettingsSectionId;
  readonly label: string;
  /** One line under the label where the section list is a screen of its own. */
  readonly description: string;
  readonly href: Route;
  readonly Icon: LucideIcon;
}

/** Every Settings section, in the order the section list shows them. */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: "appearance",
    label: "Appearance",
    description: "Theme and file list design",
    href: "/account/appearance" as Route,
    Icon: Palette,
  },
  {
    id: "browsing",
    label: "Browsing",
    description: "Row clicks and folder views",
    href: "/account/browsing" as Route,
    Icon: MousePointerClick,
  },
  {
    id: "formats",
    label: "Formats",
    description: "Sizes, dates and times",
    href: "/account/formats" as Route,
    Icon: CalendarClock,
  },
  {
    id: "password",
    label: "Password",
    description: "The password you sign in with",
    href: "/account/password" as Route,
    Icon: RectangleEllipsis,
  },
  {
    id: "encryption",
    label: "Encryption",
    description: "Encrypted folders, keys and paired Macs",
    href: "/account/encryption" as Route,
    Icon: LockKeyhole,
  },
  {
    id: "tokens",
    label: "API tokens",
    description: "Tokens for Claude and Raycast",
    href: "/account/tokens" as Route,
    Icon: KeyRound,
  },
];

/** The section `/account` itself shows. */
export const FIRST_SETTINGS_SECTION = SETTINGS_SECTIONS[0] as SettingsSection;

/**
 * The sections to list for the signed-in account: all of them, minus Encryption on an
 * installation without encrypted folders. Everything is listed while the account loads.
 */
export function settingsSectionsFor(
  me: Pick<MeResponse, "encryptedFolders"> | undefined,
): readonly SettingsSection[] {
  if (me === undefined || me.encryptedFolders) return SETTINGS_SECTIONS;
  return SETTINGS_SECTIONS.filter((section) => section.id !== "encryption");
}

/** True on `/account` itself: the first section on a wide screen, the section list on a phone. */
export function isSettingsIndex(pathname: string | null): boolean {
  return pathname === SETTINGS_ROUTE || pathname === `${SETTINGS_ROUTE}/`;
}

/** The section a pathname shows; `/account` and anything unknown fall back to the first one. */
export function settingsSectionFor(pathname: string | null): SettingsSection {
  return (
    SETTINGS_SECTIONS.find(
      (section) => pathname === section.href || pathname?.startsWith(`${section.href}/`),
    ) ?? FIRST_SETTINGS_SECTION
  );
}
