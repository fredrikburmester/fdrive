import { PreviewShell } from "@/components/preview/preview-shell";
import { segmentsToPath } from "@/lib/preview/deps";

interface ViewPageProps {
  readonly params: Promise<{ path: string[] }>;
}

/**
 * The file preview route. Decodes the catch-all `path` segments back into
 * a normalized fs path and hands off to the client `PreviewShell`, so the
 * browser's back button and deep links both work.
 */
export default async function ViewPage({ params }: ViewPageProps) {
  const { path: segments } = await params;
  const path = segmentsToPath(segments);

  return <PreviewShell path={path} />;
}
