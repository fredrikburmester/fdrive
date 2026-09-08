import type { Metadata } from "next";
import { FeaturesPage } from "@/components/system/features-page";

export const metadata: Metadata = { title: "Features - fdrive" };
export default function SystemFeaturesPage() {
  return <FeaturesPage />;
}
