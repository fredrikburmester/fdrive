import type { Metadata } from "next";
import { OfficeSystemPage } from "@/components/system/office-page";

export const metadata: Metadata = {
  title: "Office - fdrive",
};

export default function SystemOfficePage() {
  return <OfficeSystemPage />;
}
