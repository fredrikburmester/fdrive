import type { Metadata } from "next";
import { BrowsingSection } from "@/components/account/browsing-section";

export const metadata: Metadata = {
  title: "Browsing - fdrive",
};

export default function SettingsBrowsing() {
  return <BrowsingSection />;
}
