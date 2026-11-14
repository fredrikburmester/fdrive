import { OfficePage } from "@/components/office/office-page";
import { officeMode, officePathFromSegments } from "@/lib/office/route";

export const dynamic = "force-dynamic";

export default async function OfficeRoute({
  params,
  searchParams,
}: {
  params: Promise<{ path: string[] }>;
  searchParams: Promise<{ mode?: string | string[] }>;
}) {
  const [route, search] = await Promise.all([params, searchParams]);
  return <OfficePage path={officePathFromSegments(route.path)} mode={officeMode(search.mode)} />;
}
