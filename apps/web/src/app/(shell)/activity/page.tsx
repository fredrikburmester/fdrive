import type { Metadata } from "next";
import { HistoryPage } from "@/components/activity/history-page";
export const metadata: Metadata = { title: "My activity · fdrive" };
export default function Page() {
  return <HistoryPage />;
}
