import type { Metadata } from "next";
import { SharesPage } from "@/components/shares/shares-page";

export const metadata: Metadata = { title: "Shares · fdrive" };
export default function Page() {
  return <SharesPage />;
}
