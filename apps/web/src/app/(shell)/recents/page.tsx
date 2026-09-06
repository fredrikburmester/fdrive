import type { Metadata } from "next";
import { RecentsPage } from "@/components/metadata/recents-page";

export const metadata: Metadata = {
  title: "Recents · fdrive",
};

export default function Page() {
  return <RecentsPage />;
}
