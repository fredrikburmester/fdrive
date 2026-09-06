import { Download, FileQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatBytes } from "@/lib/format";
import type { PreviewKind } from "@/lib/preview/kind";

export interface UnsupportedProps {
  readonly name: string;
  readonly size: number;
  readonly kind: PreviewKind;
  /** Why there is no inline preview, from `previewUnavailableReason`. */
  readonly reason: string | null;
  readonly downloadUrl: string;
}

/**
 * Fallback shown for kinds fdrive does not render inline: a card with an
 * icon, the file's size, and a download button. Office files get a note
 * that editing arrives with ONLYOFFICE instead of the generic reason.
 */
export function Unsupported({ name, size, kind, reason, downloadUrl }: UnsupportedProps) {
  const message =
    kind === "office"
      ? "Editing arrives with ONLYOFFICE."
      : (reason ?? "This file cannot be previewed.");

  return (
    <div className="flex h-full items-center justify-center p-6">
      <Card className="max-w-sm text-center">
        <CardHeader className="items-center">
          <FileQuestion className="mx-auto mb-2 size-10 text-muted-foreground" strokeWidth={1.5} />
          <CardTitle className="break-all">{name}</CardTitle>
          <CardDescription>{formatBytes(size)}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-4">
          <p className="text-sm text-muted-foreground">{message}</p>
          <Button render={<a href={downloadUrl} download={name} />}>
            <Download data-icon="inline-start" />
            Download
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
