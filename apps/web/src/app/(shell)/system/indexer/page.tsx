import type { Metadata } from "next";
import { IndexerPage } from "@/components/system/indexer-page";

export const metadata: Metadata = {
  title: "Indexer - fdrive",
};

export default function SystemIndexerPage() {
  return <IndexerPage />;
}
