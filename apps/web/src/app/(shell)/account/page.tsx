import type { Metadata } from "next";
import { AppearanceSection } from "@/components/account/appearance-section";

export const metadata: Metadata = {
  title: "Settings - fdrive",
};

/**
 * `/account` itself: the first section on a wide screen. On a phone the frame shows the section
 * list here instead, and Appearance opens at its own URL.
 */
export default function Settings() {
  return <AppearanceSection />;
}
