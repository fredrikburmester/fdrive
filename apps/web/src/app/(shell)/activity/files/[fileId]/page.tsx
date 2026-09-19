import { CanonicalUuid } from "@fdrive/contracts";
import { notFound } from "next/navigation";
import { HistoryPage } from "@/components/activity/history-page";
export default async function Page({ params }: { params: Promise<{ fileId: string }> }) {
  const { fileId } = await params;
  if (!CanonicalUuid.safeParse(fileId).success) notFound();
  return <HistoryPage fileId={fileId} />;
}
