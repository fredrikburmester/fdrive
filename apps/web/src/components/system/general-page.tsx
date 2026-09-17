"use client";

import Link from "next/link";
import { useSystemPublicUrl } from "@/lib/api/public-url-queries";
import { PublicUrlCard } from "./public-url-card";
import { SystemPage } from "./system-page";

/**
 * Admin page: `System > General`. The installation-wide settings that are
 * neither a feature nor a sidecar: today, the address fdrive is reached at.
 * Anything that belongs to one storage server, the servers themselves and
 * their Trash, lives under `System > Storage`.
 */
export function GeneralPage() {
  const { dataUpdatedAt } = useSystemPublicUrl();

  return (
    <SystemPage
      title="General"
      description="Settings for the whole installation."
      lastUpdated={dataUpdatedAt > 0 ? new Date(dataUpdatedAt) : null}
    >
      <PublicUrlCard />
      <p className="text-sm text-muted-foreground">
        Storage servers and their Trash are managed under{" "}
        <Link href="/system/storage" className="underline">
          Storage
        </Link>
        .
      </p>
    </SystemPage>
  );
}
