import { PageHeader } from "@/components/shell/page-header";

/**
 * Placeholder for the file browser. Owned by the browser chunk, which
 * replaces this file with the real list/grid view, breadcrumbs, and
 * actions. Kept minimal on purpose: a header and an empty state only.
 */
export default function FilesPage() {
  return (
    <>
      <PageHeader breadcrumbs={<span className="text-sm font-medium">Files</span>} />
      <div className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center">
        <p className="text-sm font-medium">Files</p>
        <p className="text-sm text-muted-foreground">
          The file browser isn't built yet. This is a placeholder page.
        </p>
      </div>
    </>
  );
}
