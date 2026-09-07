import type { Metadata } from "next";
import { ImageSearchPage } from "@/components/system/image-search-page";

export const metadata: Metadata = {
  title: "Image search - fdrive",
};

export default function SystemImageSearchPage() {
  return <ImageSearchPage />;
}
