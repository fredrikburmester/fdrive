import type { Metadata } from "next";
import { AboutSheet } from "@/components/about/about-sheet";
import { serverApiClient } from "@/lib/api/server";

export const metadata: Metadata = { title: "About - fdrive" };

/** About, the last System area. The System layout admits administrators only and draws the frame. */
export default async function SystemAboutPage() {
  const client = await serverApiClient();
  return <AboutSheet about={await client.about()} />;
}
