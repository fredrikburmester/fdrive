import { OfficePage } from "@/components/office/office-page";
import { officeMode, officePathFromSegments } from "@/lib/office/route";

export const dynamic = "force-dynamic";

export default async function OfficeRoute({
  params,
  searchParams,
}: {
  params: Promise<{ identity: string; path: string[] }>;
  searchParams: Promise<{ mode?: string | string[] }>;
}) {
  const [route, search] = await Promise.all([params, searchParams]);
  return (
    <OfficePage
      identityId={route.identity}
      path={officePathFromSegments(route.path)}
      mode={officeMode(search.mode)}
    />
  );
}
