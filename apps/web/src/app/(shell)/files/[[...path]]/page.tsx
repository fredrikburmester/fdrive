import { baseName, isRoot } from "@fdrive/core";
import type { Metadata } from "next";
import { FileBrowser } from "@/components/files/file-browser";
import { segmentsToPath } from "@/lib/files/path-url";

interface FilesPageProps {
  params: Promise<{ path?: string[] }>;
}

/** Sets the tab title to the current folder's name, or "My files" at the root. */
export async function generateMetadata({ params }: FilesPageProps): Promise<Metadata> {
  const { path: segments } = await params;
  const path = segmentsToPath(segments);
  const title = isRoot(path) ? "My files" : baseName(path);
  return { title: `${title} · fdrive` };
}

/**
 * The file browser route: `/files` for the root, `/files/<segments>` for
 * any subfolder. Decodes the catch-all segments into a virtual path and
 * hands off to the client-side `FileBrowser`, which owns the listing,
 * toolbar, selection, and dialogs.
 */
export default async function FilesPage({ params }: FilesPageProps) {
  const { path: segments } = await params;
  const path = segmentsToPath(segments);

  return <FileBrowser path={path} />;
}
