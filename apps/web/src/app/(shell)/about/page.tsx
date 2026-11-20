import type { Metadata, Route } from "next";
import { redirect } from "next/navigation";
import { AboutSheet } from "@/components/about/about-sheet";
import { PageHeader } from "@/components/shell/page-header";
import { serverApiClient } from "@/lib/api/server";
import { loadMe } from "../load-me";

export const metadata: Metadata = { title: "About - fdrive" };

/**
 * `/about` on its own, for an old link or a typed address. An administrator's About is the last
 * System area, so they are sent there. Everyone else normally opens About as a sheet from the
 * account menu, and gets the same sheet here as the whole page.
 */
export default async function AboutPage() {
  const me = await loadMe();
  if (me.isAdmin) {
    redirect("/system/about" as Route);
  }
  const client = await serverApiClient();
  return (
    <>
      <PageHeader
        breadcrumbs={<span className="truncate px-1 text-muted-foreground text-sm">About</span>}
      />
      {/* No list beside it here, so no hairline: the sidebar draws its own edge. */}
      <AboutSheet about={await client.about()} className="md:border-l-0" />
    </>
  );
}
