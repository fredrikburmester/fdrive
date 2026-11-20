import { PreviewShell } from "@/components/preview/preview-shell";
import { segmentsToPath } from "@/lib/preview/deps";

interface ViewPageProps {
  readonly params: Promise<{ path: string[] }>;
  readonly searchParams: Promise<{ from?: string | string[] }>;
}

/**
 * The file preview route. Decodes the catch-all `path` segments back into
 * a normalized fs path and hands off to the client `PreviewShell`, so the
 * browser's back button and deep links both work.
 */
export default async function ViewPage({ params, searchParams }: ViewPageProps) {
  const { path: segments } = await params;
  const { from } = await searchParams;
  const path = segmentsToPath(segments);

  return <PreviewShell path={path} from={typeof from === "string" ? from : null} />;
}
