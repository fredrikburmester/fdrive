import { CanonicalUuid } from "@fdrive/contracts";
import { notFound } from "next/navigation";
import { HistoryPage } from "@/components/activity/history-page";
export default async function Page({ params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params;
  if (!CanonicalUuid.safeParse(batchId).success) notFound();
  return <HistoryPage batchId={batchId} />;
}
