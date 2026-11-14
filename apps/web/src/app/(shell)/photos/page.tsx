import type { Metadata } from "next";
import { PhotosPage } from "@/components/photos/photos-page";

export const metadata: Metadata = {
  title: "Photos · fdrive",
};

export default function Page() {
  return <PhotosPage />;
}
