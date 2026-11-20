import type { Metadata } from "next";
import { FormatsSection } from "@/components/account/formats-section";

export const metadata: Metadata = {
  title: "Formats - fdrive",
};

export default function SettingsFormats() {
  return <FormatsSection />;
}
