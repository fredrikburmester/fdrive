import type { Metadata } from "next";
import { StoragePage } from "@/components/system/storage-page";

export const metadata: Metadata = {
  title: "Storage - fdrive",
};

export default function SystemStoragePage() {
  return <StoragePage />;
}
