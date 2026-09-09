import type { Metadata } from "next";
import { GeneralPage } from "@/components/system/general-page";

export const metadata: Metadata = {
  title: "General - fdrive",
};

export default function SystemGeneralPage() {
  return <GeneralPage />;
}
