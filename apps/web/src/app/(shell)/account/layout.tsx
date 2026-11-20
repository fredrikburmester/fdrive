import type { ReactNode } from "react";
import { SettingsShell } from "@/components/account/settings-shell";

/** Every `/account` page sits in the Settings frame: the header, the section list, the section. */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return <SettingsShell>{children}</SettingsShell>;
}
