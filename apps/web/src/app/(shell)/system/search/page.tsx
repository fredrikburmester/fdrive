import type { Metadata } from "next";
import { SearchPage } from "@/components/system/search-page";

export const metadata: Metadata = {
  title: "Search - fdrive",
};

export default function SystemSearchPage() {
  return <SearchPage />;
}
