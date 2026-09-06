import type { Metadata } from "next";
import { ThumbnailsPage } from "@/components/system/thumbnails-page";

export const metadata: Metadata = {
  title: "Thumbnails - fdrive",
};

export default function SystemThumbnailsPage() {
  return <ThumbnailsPage />;
}
