import type { Metadata } from "next";
import { AppearanceSection } from "@/components/account/appearance-section";

export const metadata: Metadata = {
  title: "Appearance - fdrive",
};

export default function SettingsAppearance() {
  return <AppearanceSection />;
}
