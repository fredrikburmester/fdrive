import type { Metadata } from "next";
import { TrashPage } from "@/components/trash/trash-page";

export const metadata: Metadata = { title: "Trash · fdrive" };
export default function Page() {
  return <TrashPage />;
}
