import { EditorShell } from "@/components/editor/editor-shell";
import { segmentsToPath } from "@/lib/editor/deps";

interface EditPageProps {
  readonly params: Promise<{ path: string[] }>;
}

/**
 * The in-place file editor route. Decodes the catch-all `path` segments
 * back into a normalized fs path and hands off to the client
 * `EditorShell`, so the browser's back button and deep links both work.
 */
export default async function EditPage({ params }: EditPageProps) {
  const { path: segments } = await params;
  const path = segmentsToPath(segments);

  return <EditorShell path={path} />;
}
