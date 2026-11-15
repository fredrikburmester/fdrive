"use client";

import type { FsEntry } from "@fdrive/contracts";
import { ExternalLink } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useOfficeStatus } from "@/lib/api/office-queries";
import { opensInOffice } from "@/lib/office/capabilities";
import { officeHref } from "@/lib/office/route";
import { previewKindFor, previewUnavailableReason } from "@/lib/preview/kind";
import { Unsupported } from "./unsupported";

/** An Office file's preview: a link into the editor once Office can view it, and a download. */
export function OfficePreview({
  entry,
  downloadUrl,
}: {
  readonly entry: FsEntry;
  readonly downloadUrl: string;
}) {
  const status = useOfficeStatus();
  const available = opensInOffice(entry, status.data);
  return (
    <Unsupported
      name={entry.name}
      size={entry.size}
      kind={previewKindFor(entry)}
      reason={
        available
          ? "Open this file in office, or download a copy."
          : previewUnavailableReason(entry)
      }
      downloadUrl={downloadUrl}
      action={
        available ? (
          <Button
            nativeButton={false}
            render={<Link href={officeHref(entry.path, "view") as Route} />}
          >
            <ExternalLink data-icon="inline-start" />
            View in office
          </Button>
        ) : undefined
      }
    />
  );
}
