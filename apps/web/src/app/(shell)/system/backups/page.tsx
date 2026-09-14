import type { Metadata } from "next";
import { BackupsPage } from "@/components/system/backups-page";
export const metadata: Metadata = { title: "Backups - fdrive" };
export default function SystemBackupsPage() {
  return <BackupsPage />;
}
