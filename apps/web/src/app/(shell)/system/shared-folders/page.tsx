import type { Metadata } from "next";
import { SharedFoldersPage } from "@/components/system/shared-folders-page";

export const metadata: Metadata = {
  title: "Shared folders - fdrive",
};

export default function SystemSharedFoldersPage() {
  return <SharedFoldersPage />;
}
