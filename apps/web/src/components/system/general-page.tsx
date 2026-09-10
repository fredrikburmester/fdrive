"use client";

import Link from "next/link";
import { useSystemPublicUrl } from "@/lib/api/public-url-queries";
import { PublicUrlCard } from "./public-url-card";
import { SystemPage } from "./system-page";
import { TrashSettingsCard } from "./trash-settings-card";

/**
 * Admin page: `System > General`. The settings that are neither a feature
 * nor a sidecar: the address fdrive is reached at, and Trash. The storage
 * servers themselves moved to `System > Storage`, where several of them can
 * exist side by side.
 */
export function GeneralPage() {
  const { dataUpdatedAt } = useSystemPublicUrl();

  return (
    <SystemPage
      title="General"
      description="Server address and Trash."
      lastUpdated={dataUpdatedAt > 0 ? new Date(dataUpdatedAt) : null}
    >
      <PublicUrlCard />
      <TrashSettingsCard />
      <p className="text-sm text-muted-foreground">
        Storage servers are managed under{" "}
        <Link href="/system/storage" className="underline">
          Storage
        </Link>
        .
      </p>
    </SystemPage>
  );
}
