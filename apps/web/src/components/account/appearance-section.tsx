"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";
import { PageSection } from "@/components/shell/page-layout";
import { ChoiceRow } from "@/components/shell/setting-controls";
import { LIST_DESIGNS, type ListDesign } from "@/lib/files/list-design";
import { useListDesign } from "@/lib/files/use-list-design";

const THEMES = ["light", "dark", "system"] as const;
type Theme = (typeof THEMES)[number];

const THEME_LABELS: Record<Theme, string> = { light: "Light", dark: "Dark", system: "System" };
const THEME_ICONS = { light: Sun, dark: Moon, system: Monitor };
const THEME_HINTS: Record<Theme, string> = {
  light: "Light at any time of day.",
  dark: "Dark at any time of day.",
  system: "Light or dark, following this device.",
};

const DESIGN_LABELS: Record<ListDesign, string> = { classic: "Classic", beta: "New (beta)" };
const DESIGN_HINTS: Record<ListDesign, string> = {
  classic: "Every row has a checkbox, and folders open when you go into them.",
  beta: "Folders open in place, icons are colored, and checkboxes show after Select.",
};

function subscribeNever() {
  return () => {};
}

/**
 * The stored theme, once this browser has taken over the page. The server cannot know it, so
 * the first render shows System and the stored choice follows without a hydration mismatch.
 */
function useStoredTheme() {
  const { theme, setTheme } = useTheme();
  const hydrated = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
  const stored = hydrated ? THEMES.find((value) => value === theme) : undefined;
  return [stored ?? "system", setTheme] as const;
}

/** Settings > Appearance: the theme and the file list design, both kept in this browser. */
export function AppearanceSection() {
  const [theme, setTheme] = useStoredTheme();
  const [design, setDesign] = useListDesign();
  return (
    <PageSection title="Appearance" description="How fdrive looks in this browser.">
      <ChoiceRow
        label="Theme"
        hint={THEME_HINTS[theme]}
        value={theme}
        options={THEMES}
        labels={THEME_LABELS}
        icons={THEME_ICONS}
        onChange={setTheme}
      />
      <ChoiceRow
        label="File list"
        hint={DESIGN_HINTS[design]}
        value={design}
        options={LIST_DESIGNS}
        labels={DESIGN_LABELS}
        onChange={setDesign}
      />
    </PageSection>
  );
}
