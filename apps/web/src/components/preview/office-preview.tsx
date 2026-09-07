"use client";

import type { FsEntry } from "@fdrive/contracts";
import { ExternalLink } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useMe } from "@/lib/api/auth-queries";
import { useOfficeStatus } from "@/lib/api/office-queries";
import { opensInOffice } from "@/lib/office/capabilities";
import { officeHref } from "@/lib/office/route";
import { previewKindFor, previewUnavailableReason } from "@/lib/preview/kind";
import { Unsupported } from "./unsupported";

/** Keep the preview's identity in its link even if another account view switches identities. */
export function OfficePreview({
  entry,
  downloadUrl,
}: {
  readonly entry: FsEntry;
  readonly downloadUrl: string;
}) {
  const me = useMe();
  const status = useOfficeStatus();
  const [identityId, setIdentityId] = useState(me.data?.activeIdentityId);
  useEffect(() => {
    if (identityId === undefined && me.data) setIdentityId(me.data.activeIdentityId);
  }, [identityId, me.data]);
  const available =
    identityId !== undefined &&
    me.data?.identities.some((identity) => identity.id === identityId) &&
    opensInOffice(entry, status.data);
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
        available && identityId !== undefined ? (
          <Button
            nativeButton={false}
            render={<Link href={officeHref(identityId, entry.path, "view") as Route} />}
          >
            <ExternalLink data-icon="inline-start" />
            View in office
          </Button>
        ) : undefined
      }
    />
  );
}
