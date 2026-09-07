import { ShareId, SharePath } from "@fdrive/contracts";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PublicSharePage } from "@/components/shares/public-share-page";

export const metadata: Metadata = {
  title: "Shared with fdrive",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ path?: string | string[] }>;
}) {
  const { id } = await params;
  const { path = "/" } = await searchParams;
  if (
    !ShareId.safeParse(id).success ||
    !SharePath.safeParse(path).success ||
    typeof path !== "string"
  )
    notFound();
  return <PublicSharePage key={id} id={id} path={path} />;
}
