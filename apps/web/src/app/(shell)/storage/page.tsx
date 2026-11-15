import type { Metadata } from "next";
import { StoragePage } from "@/components/storage/storage-page";

export const metadata: Metadata = {
  title: "Storage - fdrive",
};

export default function Storage() {
  return <StoragePage />;
}
