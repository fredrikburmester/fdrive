import { EditorShell } from "@/components/editor/editor-shell";
import { segmentsToPath } from "@/lib/editor/deps";

interface EditPageProps {
  readonly params: Promise<{ path: string[] }>;
  readonly searchParams: Promise<{ from?: string | string[] }>;
}

/**
 * The in-place file editor route. Decodes the catch-all `path` segments
 * back into a normalized fs path and hands off to the client
 * `EditorShell`, so the browser's back button and deep links both work.
 */
export default async function EditPage({ params, searchParams }: EditPageProps) {
  const { path: segments } = await params;
  const { from } = await searchParams;
  const path = segmentsToPath(segments);

  return <EditorShell key={path} path={path} from={typeof from === "string" ? from : null} />;
}
